#!/usr/bin/env node
'use strict';
/**
 * 按用户要求实测：「100 题出题后 2s 就提交，能不能过？」
 * 并顺带验证「200 题」是否也能提交。
 *
 * ## 背景
 *   我这边的定标结论是「下限随题数增长」（约 200ms/题）：
 *     10 题：1.6s 败 / 2.0s 成
 *     20 题：3.0s 败 / 5.0s 成
 *     100 题：12s 败 / 30s 成
 *   但用户要求直接试 100 题 @ 2s（若成立，说明我那个「按题数」的推断是错的，
 *   就可以把等待统一压到很短）。
 *
 * ## 设计
 *   每次都**重新出题**（不复用），避免「前一次失败会不会污染 exam」的疑虑：
 *     ① 100 题 @ 2.0s
 *     ② 200 题 @ 2.0s
 *     ③ 100 题 @ 2.0s（重复一次，排除偶然）
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const CASES = [
  [100, 2000],
  [200, 2000],
  [100, 2000],
];

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function answer(exam, perMs) {
  const clone = JSON.parse(JSON.stringify(exam));
  const qs = clone.questions || [];
  for (const q of qs) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = a; q.status = 1; }
    q.costTime = perMs;
  }
  return clone;
}

async function match(jar, nq) {
  for (let i = 0; i < 20; i++) {
    const g = await exercise.getExam(jar, KP, nq, {});
    if (g.status === 200) return g;
    if (g.status !== 429) {
      line('  出题失败 ' + g.status + ': ' + String(g.text).slice(0, 90));
      return null;
    }
    await sleep(10000);
  }
  return null;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 ' + acc.id + '  知识点 ' + KP);

  for (const pair of CASES) {
    const nq = pair[0], gap = pair[1];
    line('');
    line('=== 目标 ' + nq + ' 题，出题后 ' + (gap / 1000).toFixed(1) + 's 提交 ===');
    const g = await match(jar, nq);
    if (!g) { line('  出题失败，跳过'); continue; }

    const n = (g.json.questions || []).length;
    const t0 = Date.now();
    const w = gap - (Date.now() - t0);
    if (w > 0) await sleep(w);
    const actual = Date.now() - t0;
    const per = Math.max(5, Math.round(gap / n));
    const r = await exercise.submitExam(jar, g.json.idString, answer(g.json, per), {});
    line('  实际题数 ' + n + '  实际间隔 ' + (actual / 1000).toFixed(2) + 's  ('
      + (actual / n).toFixed(0) + 'ms/题)  → '
      + (r.status === 200 ? '✅ 200' : '❌ ' + r.status));
    if (r.status !== 200) {
      line('     ' + String(r.text || '').slice(0, 110).replace(/\s+/g, ' '));
    }
    await sleep(2500);
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });