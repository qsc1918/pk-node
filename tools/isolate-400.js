#!/usr/bin/env node
'use strict';
/**
 * 隔离实验：练习提交 400 到底由哪个字段引起？
 *
 * ## 为什么要做
 *   同一批「等待时长」下，结果却互相矛盾：
 *     · 早前 probe 测试（**手工填答案、script 保持 null**）→ 200
 *     · 刚才 verify-pace-modes（走生产 `answerAll`）→ **400**（两档都 400）
 *
 *   两者差异集中在两处：
 *     ① `answerAll` 会写 `script`（笔迹 JSON 字符串）
 *     ② `answerAll` **只回传 12 个字段，丢了 `examId` 与 `ruleType`**
 *        （服务端原始 question 有 examId / ruleType）
 *
 *   ⇒ 本实验把这两点拆开验，用**同一个知识点、同样的等待**：
 *       A  answerAll 原样输出            （疑似缺字段 + 有 script）
 *       B  A 再补回 examId / ruleType    （只差 script）
 *       C  手工填答案、script=null、字段全留（早前 200 的做法）
 *       D  C 再补 script                 （只差 script，字段全留）
 *
 *   判据：若 C 过而 A 不过、B 也过 → 元凶是「缺 examId/ruleType」；
 *         若 C 过 D 不过 → 元凶是 script 格式。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));
const strokes = require(path.join(ROOT, 'src', 'strokes'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const NQ = Number(process.argv[4] || 10);
const GAP = Number(process.argv[5] || 6000);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function match(jar) {
  for (let i = 0; i < 25; i++) {
    const g = await exercise.getExam(jar, KP, NQ, {});
    if (g.status === 200) return g;
    if (g.status !== 429) { line('  出题失败 ' + g.status + ': ' + String(g.text).slice(0, 80)); return null; }
    await sleep(10000);
  }
  return null;
}

/** 手工填答案（保留服务端给的全部字段），可选补 script。 */
function manual(exam, withScript) {
  const c = JSON.parse(JSON.stringify(exam));
  (c.questions || []).forEach((q, i) => {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = String(a); q.status = 1; }
    q.costTime = 600;
    if (withScript) {
      const pts = strokes.buildPathPoints(String(a == null ? '' : a), i + 1, 'ARC');
      q.script = JSON.stringify(pts.strokes);
    }
  });
  c.correctCnt = (c.questions || []).length;
  c.costTime = 600 * (c.questions || []).length;
  return c;
}

/** answerAll 之后再补回 examId / ruleType（answerAll 会丢这两个）。 */
function withRestoredFields(exam, answered) {
  const c = JSON.parse(JSON.stringify(answered));
  c.questions.forEach((oq, i) => {
    const src = (exam.questions || [])[i] || {};
    if (src.examId != null) oq.examId = src.examId;
    if (src.ruleType != null) oq.ruleType = src.ruleType;
  });
  return c;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 ' + acc.id + '  知识点 ' + KP + '  题数 ' + NQ + '  间隔 ' + (GAP / 1000) + 's');

  const variants = [
    { name: 'A answerAll 原样', mk: (ex) => exercise.answerAll(ex, 500) },
    { name: 'B answerAll + 补 examId/ruleType', mk: (ex) => withRestoredFields(ex, exercise.answerAll(ex, 500)) },
    { name: 'C 手工填 / script=null / 字段全留', mk: (ex) => manual(ex, false) },
    { name: 'D 手工填 / 有 script / 字段全留', mk: (ex) => manual(ex, true) },
  ];

  for (const v of variants) {
    const g = await match(jar);
    if (!g) { line(v.name + ' → 出题失败，跳过'); continue; }
    const ex = g.json;
    const n = (ex.questions || []).length;

    const body = v.mk(ex);
    const q0 = body.questions[0];
    const raw0 = (ex.questions || [])[0] || {};
    const dropped = Object.keys(raw0).filter((k) => !(k in q0));
    const sc = q0.script;

    const t0 = Date.now();
    const w = GAP - (Date.now() - t0);
    if (w > 0) await sleep(w);

    const r = await exercise.submitExam(jar, ex.idString, body, {});
    line('');
    line(v.name);
    line('  ' + n + ' 题  丢字段=[' + dropped.join(',') + ']  script=' +
      (sc == null ? 'null' : (typeof sc === 'string' ? 'string(' + sc.length + ')' : typeof sc)));
    line('  → ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
      (r.status === 200 ? '  服务端判对 ' + ((r.json || {}).correctCnt) : ''));
    await sleep(2500);
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });