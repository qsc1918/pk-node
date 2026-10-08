#!/usr/bin/env node
'use strict';
/**
 * 终极隔离：把**真机 script 原样**塞进练习提交体，看能不能过。
 *
 * ## 逻辑
 *   已排除：等待时长、字段缺失、坐标范围、点数密度。
 *   剩下的只能是 **script 的表示形式**本身（类型/结构/精度/书写区基准）。
 *
 *   最强判据：**照抄真机**。真机样本 /root/alinker/pk_body.json 里的
 *   questions[i].script 是逐字节的真机产物。把它**按题循环复用**，
 *   其余字段用本次出题的真实值 —— 若这样能过，说明我们生成的
 *   script 与真机存在形式差异；若仍 400，则说明**练习与 PK 的 script
 *   口径不同**（该样本来自 PK，不能直接套用于练习）。
 *
 * ## 变体
 *   A 真机 script 原样（字符串，逐字节）
 *   B 真机 script 解析后再 stringify（排除空白与精度差异）
 *   C 我们的 script（对照，预期 400）
 *   D script = null（已知 200 的基线）
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const NQ = Number(process.argv[4] || 10);
const GAP = Number(process.argv[5] || 6000);

const REAL = JSON.parse(fs.readFileSync('/root/alinker/pk_body.json', 'utf8'));
const REAL_SCRIPTS = (REAL.questions || []).map((q) => q.script);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function match(jar) {
  for (let i = 0; i < 25; i++) {
    const g = await exercise.getExam(jar, KP, NQ, {});
    if (g.status === 200) return g;
    if (g.status !== 429) { line('  出题失败 ' + g.status); return null; }
    await sleep(10000);
  }
  return null;
}

/** 填答案，script 由 mode 决定。 */
function build(exam, mode) {
  const c = JSON.parse(JSON.stringify(exam));
  (c.questions || []).forEach((q, i) => {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = String(a); q.status = 1; }
    q.costTime = 600;
    if (mode === 'real-raw') q.script = REAL_SCRIPTS[i % REAL_SCRIPTS.length];
    else if (mode === 'real-restringify') {
      const s = REAL_SCRIPTS[i % REAL_SCRIPTS.length];
      q.script = typeof s === 'string' ? JSON.stringify(JSON.parse(s)) : JSON.stringify(s);
    } else if (mode === 'ours') {
      const r = exercise.answerAll({ questions: [q] }, 600);
      q.script = r.questions[0].script;
    } else {
      q.script = null;
    }
  });
  c.correctCnt = (c.questions || []).length;
  c.costTime = 600 * (c.questions || []).length;
  return c;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 ' + acc.id + '  知识点 ' + KP + '  题数 ' + NQ);
  line('真机 script 样本数 ' + REAL_SCRIPTS.length
    + '（首个长度 ' + String(REAL_SCRIPTS[0] || '').length + '）');

  const modes = ['real-raw', 'real-restringify', 'ours', 'null'];
  for (const mode of modes) {
    const g = await match(jar);
    if (!g) { line(mode + ' → 出题失败'); continue; }
    const ex = g.json;
    const body = build(ex, mode);
    const sc = body.questions[0].script;
    const t0 = Date.now();
    const w = GAP - (Date.now() - t0);
    if (w > 0) await sleep(w);

    const r = await exercise.submitExam(jar, ex.idString, body, {});
    line('');
    line('mode=' + mode + '  script=' + (sc == null ? 'null'
      : (typeof sc + '(' + sc.length + ')')));
    line('  → ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status));
    if (r.status === 200) {
      line('     服务端判对 ' + ((r.json || {}).correctCnt));
      line('     ★ 这个 mode 的形式是对的。');
    }
    await sleep(2500);
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });