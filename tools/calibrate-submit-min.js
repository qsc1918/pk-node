#!/usr/bin/env node
'use strict';
/**
 * 精确定标「提交间隔的下限」—— 为「冲榜模式」找出最小可行值。
 *
 * ## 已有数据（都是粗测，跨度大）
 *   10 题：0.8s 败（80ms/题） / 1.8s 成（180ms/题）
 *   100 题：12s 败（120ms/题） / 30s 成（300ms/题）
 *   ⇒ 阈值落在 100~180ms/题 之间，但没卡准。
 *
 * ## 本实验（一次出题，多间隔递增提交，卡出精确阈值）
 *
 *   关键：顶层 `costTime` 必须**等于**该档的实际间隔
 *   （已确认服务端要求「顶层 ≤ 实际间隔」）。
 *   每题 costTime 给很小的值 —— 已确认服务端**不看每题之和**。
 *
 *   所以本实验测的是：**服务端是否存在与题数无关的绝对下限**，
 *   以及单题系数的最小值。
 *
 * ⚠️ 提交必须按间隔**递增**顺序（已过时间只会增长）。
 * ⚠️ 等待基准 = 出题**成功**时刻。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 235001);
const NQ = Number(process.argv[4] || 10);
// 递增的间隔档（毫秒）；顶层 costTime 取该档值
const GAPS = (process.argv[5] || '300,600,900,1200,1600').split(',').map(Number);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

/** 每题给极小值；顶层给该档间隔。 */
function buildBody(exam, top) {
  const c = JSON.parse(JSON.stringify(exam));
  const qs = c.questions || [];
  for (const q of qs) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = String(a); q.status = 1; }
    q.costTime = 5;
  }
  c.costTime = top;
  c.correctCnt = qs.length;
  return c;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 ' + acc.id + '  知识点 ' + KP + '  题数 ' + NQ);
  line('待测间隔: ' + GAPS.join(', ') + ' ms');

  hr('出题（429 轮询，300ms 一次）');
  let g = null;
  const tMatchStart = Date.now();
  for (let i = 0; i < 400; i++) {
    g = await exercise.getExam(jar, KP, NQ, {});
    if (g.status === 200) break;
    if (g.status !== 429) { line('  出题失败 ' + g.status + ': ' + String(g.text).slice(0, 90)); process.exit(0); }
    if (Date.now() - tMatchStart > 120000) { line('  出题冷却超 120s，放弃'); process.exit(0); }
    await sleep(300);
  }
  if (!g || g.status !== 200) { line('  出题不成功'); process.exit(0); }
  const matchOkAt = Date.now();     // ★ 基准
  const n = (g.json.questions || []).length;
  line('  examId=' + g.json.idString + '  题数=' + n
    + '   （出题耗时 ' + ((matchOkAt - tMatchStart) / 1000).toFixed(1) + 's）');

  hr('多档提交（间隔递增）');
  const rows = [];
  for (const gap of GAPS) {
    const need = gap - (Date.now() - matchOkAt);
    if (need > 0) await sleep(need);
    const el = Date.now() - matchOkAt;
    const r = await exercise.submitExam(jar, g.json.idString, buildBody(g.json, el), {});
    const perQ = (el / n).toFixed(0);
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('  间隔 ' + String(el).padStart(6) + 'ms  (' + String(perQ).padStart(4) + 'ms/题)'
      + '  顶层=' + el + '  → ' + tag
      + (r.status === 200 ? '  判对 ' + ((r.json || {}).correctCnt) + '/' + n : ''));
    rows.push({ el: el, perQ: Number(perQ), status: r.status });
    await sleep(600);
  }

  hr('结论');
  const ok = rows.filter((x) => x.status === 200);
  const bad = rows.filter((x) => x.status !== 200);
  if (ok.length && bad.length) {
    const minOk = Math.min.apply(null, ok.map((x) => x.el));
    const maxBad = Math.max.apply(null, bad.map((x) => x.el));
    line('  通过的最小间隔: ' + minOk + 'ms  (' + (minOk / n).toFixed(0) + 'ms/题)');
    line('  失败的最大间隔: ' + maxBad + 'ms  (' + (maxBad / n).toFixed(0) + 'ms/题)');
    line('');
    line('  ⇒ 冲榜模式的顶层系数取 ' + Math.ceil(minOk / n) + 'ms/题 + 少量余量即可。');
  } else if (ok.length) {
    line('  全部通过 → 下限比测试最小值 ' + Math.min.apply(null, ok.map((x) => x.el)) + 'ms 还低，需往下试。');
  } else {
    line('  全部失败 → 下限比测试最大值 ' + Math.max.apply(null, bad.map((x) => x.el)) + 'ms 还高，需往上试。');
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });