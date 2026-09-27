'use strict';
// PK 刷局引擎：出题 → 组装提交 body → 加密提交 → 频控退避。
//
// ## 提交 body 结构（真机 ground truth，逐字段对齐）
//
// 顶层直接展开 examVO 字段，**没有** examVO 嵌套、**没有** userInfos、
// **没有** updatedTime（这三样加上去会 400）：
//
//   { pkIdStr, pointId, pointName, ruleType, questionCnt, correctCnt, costTime, questions }
//
// 每题 = 原始 question 深拷贝 + 补字段：
//   { id, examId, content, answer, userAnswer, answers, status, script,
//     wrongScript, ruleType, errorState, curTrueAnswer:{recognizeResult,
//     pathPoints, answer, showReductionFraction} }
//
// `script` = JSON.stringify(pathPoints)，两处内容完全一致（同源）。
//
// ## 笔迹（stroke）
//
// 服务端会回放笔迹做一致性检查，比较类题（`>` / `<`）用普通字形会被判可疑。
// 这里移植原项目的「密集弧线」模板：`<` 用左弧、`>` 用右弧，
// 坐标是画布像素（x≈150-240, y≈450-500），每题抖动 + 平移，避免完全雷同。

const { PK } = require('./config');
const leo = require('./leo');
const strokes = require('./strokes');

/** 每题 costTime 下限（毫秒）。0ms 明显不自然。 */
const MIN_COST_TIME_MS = 5;

/**
 * 兼容旧调用：生成一题的笔迹点集。
 *
 * @param {string} answer 正确答案
 * @param {number} seed   题号，保证可复现
 * @param {string} [strokeMode] `ARC`（默认）/ `SEVEN_SEGMENT`
 * @returns {Array<Array<{x:number,y:number}>>}
 */
function makePath(answer, seed, strokeMode) {
  return strokes.buildPathPoints(answer, seed, strokeMode).strokes;
}

/**
 * 组装提交 body（全对秒结算）。
 *
 * @param {object} match       出题响应 JSON（含 pkIdStr / examVO）
 * @param {object} [opts]
 * @param {number} [opts.costTimeMs] 整卷耗时；缺省按题数 × 下限
 * @param {number} [opts.seedBase]   笔迹随机种子基数
 * @param {string} [opts.strokeMode] 画笔算法：`ARC`（默认）/ `SEVEN_SEGMENT`
 * @returns {object} 待加密的明文 body
 */
function buildSubmitBody(match, opts = {}) {
  const pkIdStr = match && match.pkIdStr;
  const examVO = match && match.examVO;
  if (!pkIdStr) throw new Error('出题响应缺 pkIdStr');
  if (!examVO) throw new Error('出题响应缺 examVO');
  const questions = examVO.questions;
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('出题响应缺 questions');

  const seedBase = opts.seedBase == null ? Math.floor(Math.random() * 1e9) : opts.seedBase;
  const strokeMode = strokes.normalizeStrokeMode(opts.strokeMode);

  const outQuestions = questions.map((q, idx) => {
    const answer = pickAnswer(q);
    // 笔迹按模式生成；ARC 遇到非 `>`/`<` 会自动回落七段码（见 strokes.js）
    const pathPoints = makePath(answer, seedBase + idx, strokeMode);
    const script = JSON.stringify(pathPoints);
    return {
      id: q.id == null ? 0 : q.id,
      examId: q.examId == null ? 0 : q.examId,
      content: q.content == null ? null : q.content,
      answer: q.answer == null ? null : q.answer,
      userAnswer: answer,
      answers: q.answers == null ? null : q.answers,
      status: 1,                 // 1 = 答对
      script: script,
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
  const cost = opts.costTimeMs == null
    ? Math.max(questionCnt * MIN_COST_TIME_MS, MIN_COST_TIME_MS)
    : Math.max(Number(opts.costTimeMs), MIN_COST_TIME_MS);

  return {
    pkIdStr: pkIdStr,
    pointId: examVO.pointId == null ? 0 : examVO.pointId,
    pointName: examVO.pointName == null ? null : examVO.pointName,
    ruleType: examVO.ruleType == null ? 0 : examVO.ruleType,
    questionCnt: questionCnt,
    correctCnt: questionCnt,     // 全对
    costTime: cost,
    questions: outQuestions,
  };
}

/** 从题目里挑「正确答案」：优先 `answer`，退回 `answers[0]`。 */
function pickAnswer(q) {
  if (q && q.answer != null && String(q.answer) !== '') return String(q.answer);
  if (q && Array.isArray(q.answers) && q.answers.length > 0) return String(q.answers[0]);
  return '';
}

/** 判断一次 HTTP 结果是不是频控/风控。 */
function isRateLimited(status, text) {
  if (status === 429 || status === 403) return true;
  const t = String(text || '');
  return t.includes('频繁') || t.includes('rate') || t.includes('blocked');
}

/** 频控等待时长：base × 2^n，n 从 0 开始。 */
function backoffMs(attempt) {
  return PK.rateLimitBaseMs * Math.pow(2, Math.max(0, attempt));
}

/**
 * 跑一局：出题 → 组装 → 提交。
 *
 * @param {object} jar          已登录的 [leo.CookieJar]
 * @param {object} cfg          刷局配置
 * @param {number} cfg.pointId  知识点 ID
 * @param {number} [cfg.costTimeMs]
 * @param {number} [cfg.rateLimitBaseMs] 覆盖默认退避基数
 * @param {number} [cfg.rateLimitMaxWait] 覆盖默认最大等待次数
 * @param {number} [cfg.gapMinMs] [cfg.gapMaxMs] 出题前随机间隔（降低频控概率）
 * @param {(ev:object)=>void} [onEvent] 事件回调（写日志/UI 用）
 * @returns {Promise<{ok:boolean, httpCode:number, message:string, detail:string, pkIdStr?:string, costTimeMs?:number, encryptedBytes?:number}>}
 */
async function runOneRound(jar, cfg, onEvent, ctx) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const signal = ctx && ctx.signal;
  const t0 = Date.now();
  const anySignal = (o) => (signal ? Object.assign({}, o, { signal: signal }) : o);
  const ensureLive = () => {
    if (signal && signal.aborted) throw abortedError();
  };

  // 1) 轮间隔（规避频控）
  //
  // ⚠️ 这段等待期间日志必须**有东西可看**，否则前端会以为卡死：
  // 长间隔（默认 12~20s）里没有事件的话，用户看到的就是一片空白。
  // 所以这里每 5 秒发一个 tick，让 UI 能显示「还剩 Xs」。
  const gapMin = num(cfg.gapMinMs, 12000);
  const gapMax = num(cfg.gapMaxMs, 20000);
  const gap = gapMin + Math.floor(Math.random() * Math.max(1, gapMax - gapMin));
  if (gap > 0) {
    emit({ type: 'gap', message: `等待 ${(gap / 1000).toFixed(1)}s 以规避频控`, gapMs: gap });
    // 可中断：点「立即结束」时不用等这段等待走完
    await sleepWithTicks(gap, (leftMs) => {
      emit({ type: 'tick', message: `距下轮还有 ${Math.ceil(leftMs / 1000)}s`, leftMs: leftMs });
    }, signal);
  }
  ensureLive();

  // 2) 出题
  emit({ type: 'match', message: `出题 pointId=${cfg.pointId}` });
  const m = await leo.pkMatch(jar, cfg.pointId, anySignal({}));
  if (m.status !== 200 || !m.json) {
    return fail(m.status, `出题失败 HTTP ${m.status}`, m.text, t0);
  }
  const pkIdStr = m.json.pkIdStr;
  const qCount = (m.json.examVO && m.json.examVO.questions) ? m.json.examVO.questions.length : 0;
  emit({ type: 'match-ok', message: `出题成功：pkIdStr=${pkIdStr}，共 ${qCount} 题` });

  // 2.5) 拿到题目 → 提交答案 之间的间隔（可配）
  //
  // 真人是「看一眼题、写答案、再交卷」，不是秒交。这里给一段可配的等待，
  // 让提交节奏更自然（也顺便错开频控窗口）。
  const dMin = num(cfg.submitDelayMinMs, 0);
  const dMax = num(cfg.submitDelayMaxMs, 0);
  if (dMax > 0 || dMin > 0) {
    const lo = Math.min(dMin, dMax);
    const hi = Math.max(dMin, dMax);
    const delay = lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
    if (delay > 0) {
      emit({ type: 'delay', message: `答题间隔：${(delay / 1000).toFixed(1)}s 后提交` });
      await sleepWithTicks(delay, (leftMs) => {
        emit({ type: 'tick', message: `距提交还有 ${Math.ceil(leftMs / 1000)}s`, leftMs: leftMs });
      }, signal);
      ensureLive();
    }
  }

  // 3) 组装 + 提交（含频控退避）
  const maxWait = num(cfg.rateLimitMaxWait, PK.rateLimitMaxWait);
  const strokeLabel = strokes.STROKE_MODE_LABELS[strokes.normalizeStrokeMode(cfg.strokeMode)];
  let attempt = 0;
  for (;;) {
    let bodyObj;
    try {
      bodyObj = buildSubmitBody(m.json, {
        costTimeMs: cfg.costTimeMs,
        seedBase: (Date.now() % 1e9) + attempt,
        strokeMode: cfg.strokeMode,
      });
    } catch (e) {
      return fail(m.status, '组装提交体失败：' + e.message, '', t0);
    }

    // 4) 加密（会起 native 进程，约 80~250ms）
    emit({ type: 'encode', message: `加密提交体（画笔算法：${strokeLabel}）` });
    let cipher;
    try {
      cipher = require('./native').encodeSubmitBody(Buffer.from(JSON.stringify(bodyObj), 'utf8'));
    } catch (e) {
      return fail(null, '内容编码失败：' + e.message, '', t0);
    }
    emit({ type: 'encode-ok', message: `加密完成：明文 ${Buffer.byteLength(JSON.stringify(bodyObj))}B → 密文 ${cipher.length}B` });

    // 5) 提交
    emit({ type: 'submit', message: `提交（第 ${attempt + 1} 次）costTime=${bodyObj.costTime}ms 全对 ${bodyObj.correctCnt}/${bodyObj.questionCnt}` });
    const s = await leo.pkSubmitRaw(jar, cipher, anySignal({}));
    if (s.status === 200) {
      // ⚠️ 提交 200 ≠ 这局已结算。MUST 再拉一次结算接口核对
      // （真机上这是结算页 result.html 的数据源，见 leo.pkHistoryDetail 注释）。
      // 没结算成功的局在服务端是 {correctCnt:0, questions:null} 的占位记录。
      const settle = await confirmSettle(jar, pkIdStr, bodyObj, emit, signal);
      if (!settle.ok) {
        return {
          ok: false,
          httpCode: 200,
          message: settle.message,
          detail: settle.raw,
          pkIdStr: pkIdStr,
          costTimeMs: Date.now() - t0,
        };
      }
      return {
        ok: true,
        httpCode: 200,
        message: settle.message,
        detail: JSON.stringify(settle.detail).slice(0, 2000),
        pkIdStr: pkIdStr,
        settled: settle.detail,
        costTimeMs: Date.now() - t0,
      };
    }

    if (isRateLimited(s.status, s.text) && attempt < maxWait) {
      const wait = backoffMs(attempt) * (num(cfg.rateLimitBaseMs, PK.rateLimitBaseMs) / PK.rateLimitBaseMs);
      emit({ type: 'rate-limit', message: `HTTP ${s.status} 频控，退避 ${(wait / 1000).toFixed(0)}s 后重试` });
      await sleepWithTicks(wait, (leftMs) => {
        emit({ type: 'tick', message: `退避中，还剩 ${Math.ceil(leftMs / 1000)}s`, leftMs: leftMs });
      }, signal);
      ensureLive();
      attempt++;
      continue;
    }
    return fail(s.status, `提交失败 HTTP ${s.status}`, s.text, t0, pkIdStr);
  }
}

/**
 * 提交后核对结算（对齐结算页 `result.html?pkIdStr=X` 的数据源）。
 *
 * 返回 `{ok, message, detail}`：
 *  - `ok:true`  服务端已有逐题明细（`correctCnt > 0` 且 `questions` 非空）
 *  - `ok:false` 仍是 `{correctCnt:0, questions:null}` 的占位记录 → 这局没算上
 *
 * 只读接口，**不计入出题频控**，所以可以放心在每轮都调。
 */
async function confirmSettle(jar, pkIdStr, sentBody, emit, signal) {
  const r = await leo.pkHistoryDetail(jar, pkIdStr, { signal: signal });
  const j = r.json;
  if (r.status !== 200 || !j) {
    emit({ type: 'settle', message: `结算核对失败 HTTP ${r.status}（提交本身已是 200）` });
    // 结算接口查不到不代表这局一定失败：可能只是历史还没落库。
    // 此时按「提交成功」记账，但把情况写进 detail，不误报失败。
    return {
      ok: true,
      message: `提交成功（结算明细未取到，HTTP ${r.status}）`,
      detail: { settled: false, reason: 'history/detail ' + r.status, sent: sentBody.correctCnt },
      raw: String(r.text || '').slice(0, 500),
    };
  }
  const cnt = Number(j.correctCnt) || 0;
  const qs = Array.isArray(j.questions) ? j.questions.length : 0;
  if (cnt > 0 && qs > 0) {
    emit({ type: 'settle-ok', message: `已结算：答对 ${cnt} 题 / 明细 ${qs} 题` });
    return {
      ok: true,
      message: `提交成功并已结算（对 ${cnt} 题）`,
      detail: {
        settled: true, correctCnt: cnt, questionCnt: Number(j.questionCnt) || qs,
        pointId: j.pointId, pointName: j.pointName, costTime: j.costTime,
      },
    };
  }
  emit({ type: 'settle-fail', message: `服务端未结算（correctCnt=${cnt}, questions=${j.questions === null ? 'null' : qs}）—— 这局没算上` });
  return {
    ok: false,
    message: `提交返回 200 但未被结算（correctCnt=${cnt}）`,
    detail: JSON.stringify(j).slice(0, 600),
    raw: String(r.text || '').slice(0, 600),
  };
}

/** 中断错误：`aborted === true`，上层据此把任务标成 stopped 而不是 failed。 */
function abortedError() {
  const e = new Error('任务已被手动结束');
  e.aborted = true;
  return e;
}

function fail(status, message, detail, t0, pkIdStr) {
  return {
    ok: false,
    httpCode: status,
    message: message,
    detail: String(detail || '').slice(0, 2000),
    pkIdStr: pkIdStr,
    costTimeMs: Date.now() - t0,
  };
}

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带「滴答」的长睡眠：每 5 秒回调一次剩余毫秒；**可被 signal 立即中断**。
 *
 * 用途：轮间隔 / 答题间隔 / 频控退避期间既给前端发心跳（避免日志空白），
 * 又能让「立即结束」不用等这段等待走完。
 *
 * @param {number} ms
 * @param {(leftMs:number)=>void} onTick
 * @param {AbortSignal} [signal] 中断信号
 */
async function sleepWithTicks(ms, onTick, signal) {
  const total = Math.max(0, Number(ms) || 0);
  const TICK = 5000;
  let left = total;
  while (left > 0) {
    if (signal && signal.aborted) throw abortedError();
    const step = Math.min(TICK, left);
    // eslint-disable-next-line no-await-in-loop
    await sleepAbortable(step, signal);
    left -= step;
    // left === 0 时不回报：说「还剩 0s」没有意义，下一行就是实际动作了
    if (left <= 0) break;
    try { onTick(left); } catch (e) { /* 回调异常不影响任务 */ }
  }
}

/**
 * 可中断的 sleep：signal 触发时**立刻** reject，不等睡满。
 *
 * 这是「立即结束」的关键 —— 否则点停止后要等最长 20s 的轮间隔才停。
 */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortedError());
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortedError());
    }
    if (signal) {
      if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      else signal.once('abort', onAbort);   // 兼容只有 once 的实现
    }
  });
}

module.exports = {
  MIN_COST_TIME_MS,
  makePath,
  buildSubmitBody,
  pickAnswer,
  isRateLimited,
  backoffMs,
  runOneRound,
};