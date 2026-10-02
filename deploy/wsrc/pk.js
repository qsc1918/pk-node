// PK 刷局业务逻辑（Worker 版）。
//
// 一轮 = 出题(match/v2) → 组装提交体 → 编码提交(submit) → 结算核对(history/detail)
// 逐项对齐本机 pk-node 的 src/leo.js + src/pk-engine.js。

import { buildUrl, mainDomainHeaders, riskHeaders } from './leo.js';
import { PATH, MIN_COST_TIME_MS, LEO_BASE } from './signcfg.js';
import { encodeBody, decodeBody } from './codec.js';
import { buildPathPoints, STROKE_MODES, normalizeStrokeMode } from './strokes.js';

/** 取正确答案：优先 answer，退回 answers[0]。 */
export function pickAnswer(q) {
  if (!q) return '';
  if (q.answer != null && String(q.answer) !== '') return String(q.answer);
  if (Array.isArray(q.answers) && q.answers.length) return String(q.answers[0]);
  return '';
}

/**
 * 组装提交体（真机 ground truth：顶层直接展开 examVO 字段，无 examVO 嵌套 / userInfos / updatedTime）。
 */
export function buildSubmitBody(match, opts) {
  const o = opts || {};
  const pkIdStr = match && match.pkIdStr;
  const examVO = match && match.examVO;
  if (!pkIdStr) throw new Error('出题响应缺 pkIdStr');
  if (!examVO) throw new Error('出题响应缺 examVO');
  const questions = examVO.questions;
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('出题响应缺 questions');

  const seedBase = o.seedBase == null ? Math.floor(Math.random() * 1e9) : o.seedBase;
  const strokeMode = normalizeStrokeMode(o.strokeMode || STROKE_MODES.ARC);

  const outQuestions = questions.map((q, idx) => {
    const answer = pickAnswer(q);
    const pathPoints = buildPathPoints(answer, seedBase + idx, strokeMode).strokes;
    return {
      id: q.id == null ? 0 : q.id,
      examId: q.examId == null ? 0 : q.examId,
      content: q.content == null ? null : q.content,
      answer: q.answer == null ? null : q.answer,
      userAnswer: answer,
      answers: q.answers == null ? null : q.answers,
      status: 1,
      script: JSON.stringify(pathPoints),
      wrongScript: null,
      ruleType: q.ruleType == null ? null : q.ruleType,
      errorState: q.errorState == null ? 0 : q.errorState,
      curTrueAnswer: {
        recognizeResult: answer,
        pathPoints: pathPoints,
        answer: 1,
        showReductionFraction: 0,
      },
    };
  });

  const questionCnt = outQuestions.length;
  const cost = o.costTimeMs == null
    ? Math.max(questionCnt * MIN_COST_TIME_MS, MIN_COST_TIME_MS)
    : Math.max(Number(o.costTimeMs), MIN_COST_TIME_MS);

  return {
    pkIdStr: pkIdStr,
    pointId: examVO.pointId == null ? 0 : examVO.pointId,
    pointName: examVO.pointName == null ? null : examVO.pointName,
    ruleType: examVO.ruleType == null ? 0 : examVO.ruleType,
    questionCnt: questionCnt,
    correctCnt: questionCnt,
    costTime: cost,
    questions: outQuestions,
  };
}

// ---------------------------------------------------------------- HTTP

function cookieHeader(jar) {
  return typeof jar === 'string' ? jar : (jar && jar.cookie) || '';
}

async function request(url, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  const ck = cookieHeader(o.jar);
  if (ck) headers['Cookie'] = ck;
  const init = { method: o.method || 'GET', headers: headers };
  if (o.body != null) init.body = o.body;
  const r = await fetch(url, init);
  const buf = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, buf: buf, headers: r.headers };
}

/** 试着把字节当普通 JSON 解（含 gzip 自动解压由 fetch 完成；这里兼容明文）。 */
function tryPlainJson(buf) {
  try {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    // 明文 JSON（可能被 gzip 过，fetch 已解）
    if (bytes[0] === 0x7b || bytes[0] === 0x5b) {
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    return null;
  } catch (e) {
    return null;
  }
}

/** PK 出题（v2，加密响应）。 */
export async function pkMatchV2(jar, pointId, shepherdDid) {
  const url = buildUrl(PATH.matchV2, { pointId: String(pointId), triggerPeakMatch: '0' });
  const r = await request(url, {
    method: 'POST',
    jar: jar,
    headers: mainDomainHeaders({ 'Content-Type': 'application/json' }, shepherdDid),
    body: '{}',
  });
  const json = await decodeBody(r.buf);
  return { status: r.status, json: json };
}

/** PK 提交（体需编码成 octet-stream；方法必须是 PUT，且要带 Referer）。 */
export async function pkSubmit(jar, body, shepherdDid) {
  const url = buildUrl(PATH.submit, {});
  const encoded = await encodeBody(body);
  const r = await request(url, {
    method: 'PUT',   // ⚠️ 必须是 PUT：用 POST 会 405（实测）
    jar: jar,
    headers: mainDomainHeaders({
      'Content-Type': 'application/octet-stream',
      Referer: LEO_BASE + '/bh5/leo-web-oral-pk/pk.html',
    }, shepherdDid),
    body: encoded,
  });
  const json = await decodeBody(r.buf);
  return { status: r.status, json: json };
}

/** 结算核对（history/detail）。 */
export async function pkHistoryDetail(jar, pkIdStr, shepherdDid) {
  const url = buildUrl(PATH.historyDetail, { pkIdStr: String(pkIdStr) });
  const r = await request(url, {
    method: 'GET',
    jar: jar,
    headers: mainDomainHeaders({
      Referer: LEO_BASE + '/bh5/leo-web-oral-pk/result.html?pkIdStr=' + encodeURIComponent(pkIdStr),
    }, shepherdDid),
  });
  const json = await decodeBody(r.buf);
  return { status: r.status, json: json };
}

/** 是否为频控（403 / 429 / 文案含「频繁」）。 */
export function isRateLimited(status, json) {
  if (status === 403 || status === 429) return true;
  const msg = json && (json.message || json.msg);
  return typeof msg === 'string' && /频繁|too_many|rate/i.test(msg);
}

export { riskHeaders };