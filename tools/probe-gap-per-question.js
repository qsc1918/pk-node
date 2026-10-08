#!/usr/bin/env node
'use strict';
/**
 * 精确定标「提交下限 vs 题数」的关系。
 *
 * ## 已有数据（全部实测）
 *   | 题数 | 通过的最小间隔 |
 *   |------|---------------|
 *   | 10   | ≥1.8s（0.8s 失败） |
 *   | 20   | ≥5.0s（3.0s 失败） |
 *   | 100  | ≥30s（12s 失败）   |
 *
 *   ⇒ 明显与题数正相关，近似 250~300ms/题。
 *   这就是「10 题只要 2s、100 题要 30s」的来源，也是我 90s 等待的
 *   真实依据（只是我原先按 900ms/题 算，高估了约 3 倍）。
 *
 * ## 本脚本
 *   在 10 题上做细粒度梯度，把单题系数卡准：
 *     1.2s → 1.6s → 2.0s → 2.6s
 *   然后按比例推 100 题该等多久。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const NQ = Number(process.argv[4] || 10);
const GAPS = (process.argv[5] || '1200,1600,2000,2600,3400').split(',').map(Number);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

function answer(exam, perMs) {
  const clone = JSON.parse(JSON.stringify(exam));
  const qs = clone.questions || [];
  for (const q of qs) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = a; q.status = 1; }
    q.costTime = perMs;
  }
  clone.costTime = perMs * qs.length;
  clone.correctCnt = qs.length;
  return clone;
}

async function match(jar) {
  for (let i = 0; i < 20; i++) {
    const g = await exercise.getExam(jar, KP, NQ, {});
    if (g.status === 200) return g;
    if (g.status !== 429) { line('  出题失败 ' + g.status); return null; }
    await sleep(10000);
  }
  return null;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 id=' + acc.id + '  知识点=' + KP + '  题数=' + NQ);
  line('待测间隔: ' + GAPS.map((g) => (g / 1000).toFixed(1) + 's').join(', '));

  hr('梯度（每档重新出题）');
  const res = [];
  for (const gap of GAPS) {
    const g = await match(jar);
    if (!g) { line('  出题失败，停止'); break; }
    const n = (g.json.questions || []).length;
    const t0 = Date.now();
    const w = gap - (Date.now() - t0);
    if (w > 0) await sleep(w);
    const actual = Date.now() - t0;
    const per = Math.max(5, Math.round(gap / n));
    const r = await exercise.submitExam(jar, g.json.idString, answer(g.json, per), {});
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('  间隔 ' + (actual / 1000).toFixed(2) + 's  (' + n + ' 题, ' + (actual / n).toFixed(0) + 'ms/题)  → ' + tag);
    res.push({ gap: actual, n, status: r.status });
    await sleep(2500);
  }

  hr('汇总');
  const ok = res.filter((r) => r.status === 200);
  const bad = res.filter((r) => r.status !== 200);
  if (ok.length) {
    const minOk = Math.min.apply(null, ok.map((r) => r.gap));
    line('  通过的最小间隔: ' + minOk + 'ms  (' + (minOk / res[0].n).toFixed(0) + 'ms/题)');
  }
  if (bad.length) {
    const maxBad = Math.max.apply(null, bad.map((r) => r.gap));
    line('  失败的最大间隔: ' + maxBad + 'ms  (' + (maxBad / res[0].n).toFixed(0) + 'ms/题)');
  }
  if (ok.length && bad.length) {
    const lo = maxBad, hi = Math.min.apply(null, ok.map((r) => r.gap));
    line('');
    line('  ⇒ 单题阈值落在 ' + (lo / res[0].n).toFixed(0) + '~' + (hi / res[0].n).toFixed(0) + ' ms/题');
    line('     取上限加余量即可覆盖所有题数：');
    for (const n of [10, 20, 50, 100]) {
      line('       ' + String(n).padStart(3) + ' 题 → 约 ' + ((hi / res[0].n * 1.15 * n) / 1000).toFixed(1) + 's');
    }
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });