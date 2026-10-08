#!/usr/bin/env node
'use strict';
/**
 * 判别实验：提交时间的下限是「按声明的 costTime」还是「按实际间隔」？
 *
 * ## 为什么必须区分
 *   两套假设都能解释已有数据（因为之前测试里两者恰好相等）：
 *
 *   H1 声明制：服务端要求 `Σ每题 costTime ≥ 题数 × X`
 *      → 只要把 costTime 声明大，就能立即提交，**不用等**。
 *   H2 间隔制：服务端要求 `提交时刻 − 出题时刻 ≥ 题数 × X`
 *      → 无论声明多少，都必须真等。
 *
 *   这决定「90s 等待」能不能真正省掉：
 *     H1 成立 → 声明大即可秒交（最优）
 *     H2 成立 → 必须按题数等（100 题约 18~30s）
 *
 * ## 判别设计
 *   10 题，**声明很大的 costTime（每题 5000ms，总 50s）**，但只在 1.0s 提交。
 *     · 200 → H1（声明制）：把声明写大就行
 *     · 400 → H2（间隔制）：必须真等
 *   再做一组反向：声明很小（每题 1ms），但真等 5s。
 *     · 200 → 说明声明值无关，纯看间隔；结合上组可定论
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

/** 生成提交体：perMs = 每题声明耗时；topMs = 顶层 costTime（不给则 = per×题数）。 */
function body(exam, perMs, topMs) {
  const clone = JSON.parse(JSON.stringify(exam));
  const qs = clone.questions || [];
  for (const q of qs) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = a; q.status = 1; }
    q.costTime = perMs;
  }
  clone.costTime = topMs == null ? perMs * qs.length : topMs;
  clone.correctCnt = qs.length;
  return clone;
}

async function match(jar) {
  for (let i = 0; i < 20; i++) {
    const g = await exercise.getExam(jar, KP, 10, {});
    if (g.status === 200) return g;
    if (g.status !== 429) { line('  出题失败 ' + g.status + ': ' + String(g.text).slice(0, 100)); return null; }
    line('  429，等 10s');
    await sleep(10000);
  }
  return null;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 id=' + acc.id + '  知识点=' + KP);

  hr('第 1 组：声明很大（每题 5000ms）但**只等 1.0s**');
  let g = await match(jar);
  if (!g) { line('  出题失败，退出'); process.exit(0); }
  line('  examId=' + g.json.idString + '  题数=' + (g.json.questions || []).length);
  let t0 = Date.now();
  await sleep(1000);
  let r = await exercise.submitExam(jar, g.json.idString, body(g.json, 5000), {});
  line('  间隔 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's  声明每题 5000ms  → ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status));
  line('     ' + String(r.text || '').slice(0, 130).replace(/\s+/g, ' '));
  const r1 = r.status;

  await sleep(3000);

  hr('第 2 组：声明极小（每题 1ms）但**真等 5.0s**');
  g = await match(jar);
  if (!g) { line('  出题失败，退出'); process.exit(0); }
  line('  examId=' + g.json.idString + '  题数=' + (g.json.questions || []).length);
  t0 = Date.now();
  const w = 5000 - (Date.now() - t0);
  if (w > 0) await sleep(w);
  r = await exercise.submitExam(jar, g.json.idString, body(g.json, 1), {});
  line('  间隔 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's  声明每题 1ms  → ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status));
  line('     ' + String(r.text || '').slice(0, 130).replace(/\s+/g, ' '));
  const r2 = r.status;

  hr('判定');
  if (r1 === 200) {
    line('  第 1 组 200 → **声明制（H1）**：把 costTime 声明大即可秒交，无需真等。');
  } else if (r2 === 200) {
    line('  第 1 组 400 且第 2 组 200 → **间隔制（H2）**：声明值无关，必须真等。');
  } else {
    line('  两组都 400 → 声明与间隔都不是决定因素，另有规则。');
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });