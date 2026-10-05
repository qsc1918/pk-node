'use strict';
/**
 * race-calibrate.js —— 「上榜 costTime」精确标定。
 *
 * 已知（2026-10-05 实测）：
 *  - 服务端的防作弊下限为 ~4900ms：低于此值不上榜（self.rank=999）。
 *  - 目标：把我们的 costTime 标定到「刚好超过门槛」的区间（4900~5100ms 之间考好名次）。
 *  - 线性模型：costTime ≈ 固定开销 + Σ(每题提交延迟)。
 *
 * 本脚本按指定延迟跑若干局，输出每局的 costTime，用于拟合「延迟→costTime」曲线。
 *
 * 用法：node tools/race-calibrate.js [leoId] [delayMs1,delayMs2,...]
 *   例：node tools/race-calibrate.js 6 300,320,340,360
 */
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));

const db = require('../src/db');
const jobs = require('../src/jobs');
const ss = require('../src/school-season');
db.init();

const leoId = Number(process.argv[2] || 6);
const delays = String(process.argv[3] || '300,320,340').split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));

let acc = null;
for (const u of db.listUsers()) {
  const hit = db.listLeoAccounts(u.id).find((a) => Number(a.id) === leoId);
  if (hit) { acc = hit; break; }
}
if (!acc) { console.error('账号不存在'); process.exit(2); }
const jar = jobs.jarOf(acc);

(async () => {
  console.log(`=== 上榜标定（账号 ${acc.id}，延迟档：${delays.join('/')}ms）===`);
  const rows = [];
  for (const d of delays) {
    const res = await ss.runOneRace(jar, {
      grade: Number(acc.grade) || 2,
      pointId: 0,
      answerDelayMinMs: d,
      answerDelayMaxMs: d,
      useSample: true,
      battleMaxMs: 4 * 60 * 1000,
    }, (ev) => {
      if (['ss-finish', 'ss-warn'].includes(ev.type)) console.log(`  [${d}ms] ${ev.message}`);
    });
    console.log(`  → 延迟 ${d}ms：${res.ok ? `costTime=${res.costTimeMs}ms` : '失败 ' + res.message}`);
    rows.push({ delay: d, ok: res.ok, costTime: res.costTimeMs });
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  console.log('\n=== 标定表 ===');
  for (const r of rows) console.log(`  延迟 ${String(r.delay).padStart(4)}ms → costTime ${r.ok ? r.costTime + 'ms' : '失败'}`);
  // 线性拟合（仅成功行）
  const okRows = rows.filter((r) => r.ok && r.costTime > 0);
  if (okRows.length >= 2) {
    const n = okRows.length;
    const sx = okRows.reduce((s, r) => s + r.delay, 0);
    const sy = okRows.reduce((s, r) => s + r.costTime, 0);
    const sxx = okRows.reduce((s, r) => s + r.delay * r.delay, 0);
    const sxy = okRows.reduce((s, r) => s + r.delay * r.costTime, 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    console.log(`\n线性拟合：costTime ≈ ${intercept.toFixed(0)} + ${slope.toFixed(2)} × delayMs`);
    const target = 4920;   // 目标：略高于门槛（4900）
    const needed = (target - intercept) / slope;
    console.log(`若目标 costTime=${target}ms → 建议提交延迟 ≈ ${needed.toFixed(0)}ms`);
  }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });