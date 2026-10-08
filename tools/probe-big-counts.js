#!/usr/bin/env node
'use strict';
/**
 * 标定「提交下限」在 100 / 200 题上的精确阈值，以便用**最小可行等待**。
 *
 * ## 已确认（用户要求实测）
 *   100 题 @ 2.0s → 400（连试两次都失败）
 *   200 题 @ 2.0s → 400
 *   ⇒ 服务端确实按题数放大，压不到 2s。
 *
 * ## 已有梯度
 *   10 题：1.6s 败 / 2.0s 成
 *   20 题：3.0s 败 / 5.0s 成
 *   100 题：12s 败 / 30s 成
 *   ⇒ 单题约 200ms。
 *
 * ## 本次：在 100 / 200 题上把系数卡到最小
 *   100 题：18s / 22s
 *   200 题：32s / 40s
 *   每档重新出题，通过即记下，用于定最终系数。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const CASES = (process.argv[4] || '100:18000,100:22000,200:40000').split(',').map((s) => {
  const p = s.split(':');
  return [Number(p[0]), Number(p[1])];
});

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
  for (let i = 0; i < 25; i++) {
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
  const res = [];

  for (const c of CASES) {
    const nq = c[0], gap = c[1];
    line('');
    line('=== ' + nq + ' 题 @ ' + (gap / 1000).toFixed(1) + 's (' + (gap / nq).toFixed(0) + 'ms/题) ===');
    const g = await match(jar, nq);
    if (!g) { line('  出题失败，跳过'); continue; }
    const n = (g.json.questions || []).length;

    const t0 = Date.now();
    const w = gap - (Date.now() - t0);
    if (w > 0) await sleep(w);
    const actual = Date.now() - t0;

    const r = await exercise.submitExam(jar, g.json.idString, answer(g.json, Math.max(5, Math.round(actual / n))), {});
    const ok = r.status === 200;
    line('  实际 ' + (actual / 1000).toFixed(2) + 's  (' + (actual / n).toFixed(0) + 'ms/题)  → '
      + (ok ? '✅ 200' : '❌ ' + r.status));
    if (!ok) line('     ' + String(r.text || '').slice(0, 110).replace(/\s+/g, ' '));
    res.push({ nq: n, ms: actual, perQ: actual / n, ok });
    await sleep(2500);
  }

  line('');
  line('=== 汇总（单题阈值）===');
  for (const r of res) {
    line('  ' + String(r.nq).padStart(3) + ' 题  ' + (r.ms / 1000).toFixed(1) + 's  '
      + r.perQ.toFixed(0) + 'ms/题  ' + (r.ok ? '通过' : '失败'));
  }
  const okPer = res.filter((r) => r.ok).map((r) => r.perQ);
  const badPer = res.filter((r) => !r.ok).map((r) => r.perQ);
  if (okPer.length) line('  通过的最小单题值: ' + Math.min.apply(null, okPer).toFixed(0) + ' ms/题');
  if (badPer.length) line('  失败的最大单题值: ' + Math.max.apply(null, badPer).toFixed(0) + ' ms/题');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });