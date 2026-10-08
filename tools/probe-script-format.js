#!/usr/bin/env node
'use strict';
/**
 * 定位「练习提交 400 error」的真因：`script`（笔迹）字段的**格式**。
 *
 * ## 决定性对照（已实测）
 *   · 手工填 userAnswer/status/costTime，**不带 script** → HTTP 200 ✅
 *   · 走 `answerAll`（script = JSON.stringify(点集)）    → HTTP 400 ❌
 *
 * 唯一差异就是 `script`。所以 400 由它的**类型/结构**引起，
 * 而不是内容合法性问题（服务端是反序列化失败，报文只回 "error"）。
 *
 * ## 做法
 *   出 1 次题，对同一个 exam 依次试多种 script 形态，
 *   每次之间留足间隔。谁返回 200 谁就是正确格式。
 *
 *   形态候选：
 *     A 无 script（基线，已知 200）
 *     B script = JSON 字符串（现代码）
 *     C script = 数组（直接放点集）
 *     D script = 对象（点集本身）
 *     E script = 空数组
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));
const strokes = require(path.join(ROOT, 'src', 'strokes'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 235001);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(92)); line(t); line('='.repeat(92)); }

/** 复制一份 exam 并填好答案，script 按传入的形态设置。 */
function makeBody(exam, scriptMode) {
  const clone = JSON.parse(JSON.stringify(exam));
  clone.questions = (clone.questions || []).map((q, idx) => {
    const ans = q.answer == null ? '' : String(q.answer);
    const pts = strokes.buildPathPoints(ans, idx + 1, 'ARC');
    // buildPathPoints 返回 { strokes: [...] }，取点集
    const pointArr = (pts && pts.strokes) || [];
    let script;
    switch (scriptMode) {
      case 'none': script = undefined; break;
      case 'json-string': script = JSON.stringify(pointArr); break;
      case 'array': script = pointArr; break;
      case 'object': script = { strokes: pointArr }; break;
      case 'empty-array': script = []; break;
      default: script = undefined;
    }
    const out = {
      id: q.id,
      content: q.content,
      answer: q.answer,
      userAnswer: ans,
      answers: q.answers || [ans],
      wrongScript: null,
      status: 1,
      errorState: 0,
      costTime: 900,
    };
    if (script !== undefined) out.script = script;
    else out.script = null;
    return out;
  });
  clone.correctCnt = clone.questions.length;
  clone.costTime = 900 * clone.questions.length;
  return clone;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号 ' + ACC_ID); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 id=' + acc.id + '  yfd_u=' + acc.yfd_u);

  hr('① 出题');
  const g = await exercise.getExam(jar, KP, 10, {});
  line('  HTTP ' + g.status);
  if (g.status !== 200) {
    line('  出题失败（' + String(g.text || '').slice(0, 120) + '）→ 稍后重试');
    process.exit(0);
  }
  const exam = g.json;
  line('  examId = ' + exam.idString + '  题数 = ' + (exam.questions || []).length);

  // 先看一眼笔迹点集的真实结构（供人眼确认）
  const sample = strokes.buildPathPoints(String(exam.questions[0].answer), 1, 'ARC');
  line('');
  line('  buildPathPoints 返回类型: ' + typeof sample);
  line('  顶层键: ' + Object.keys(sample || {}).join(', '));
  const arr = (sample && sample.strokes) || [];
  line('  点集长度: ' + arr.length);
  line('  第一个点: ' + JSON.stringify(arr[0]));
  line('  前 3 点: ' + JSON.stringify(arr.slice(0, 3)));

  const modes = ['none', 'json-string', 'array', 'object', 'empty-array'];
  hr('② 逐形态试提交（每形态间隔 4s）');
  const res = [];
  for (const m of modes) {
    const body = makeBody(exam, m);
    const r = await exercise.submitExam(jar, exam.idString, body, {});
    const tag = r.status === 200 ? '✅ 200' : (r.status === 400 ? '❌ 400' : '⚠️ ' + r.status);
    line('  script=' + m.padEnd(13) + ' → ' + tag
      + (r.status === 200 ? '   correctCnt=' + ((r.json || {}).correctCnt) : ''));
    if (r.status !== 200) {
      line('      body: ' + String(r.text || '').slice(0, 150).replace(/\s+/g, ' '));
    }
    res.push({ m, status: r.status, json: r.json });
    await sleep(4000);
  }

  hr('判定');
  const okModes = res.filter((r) => r.status === 200).map((r) => r.m);
  if (!okModes.length) {
    line('  全部 400 —— script 不是唯一变量，或服务端有新校验。');
  } else {
    line('  可用形态: ' + okModes.join(', '));
    const graded = res.filter((r) => r.status === 200 && Number((r.json || {}).correctCnt) > 0);
    if (graded.length) {
      line('  其中被服务端判对（correctCnt>0）的: ' + graded.map((r) => r.m).join(', '));
      line('  → 这个形态既是合法格式、又能被服务端认出笔迹。');
    } else {
      line('  但没有一个形态让 correctCnt>0 —— 笔迹内容仍不被服务端认可。');
    }
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });