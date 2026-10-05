'use strict';
/**
 * race-aimtest.js —— 贴限模式（aimCostMode）端到端实测。
 *
 * 用法：node tools/race-aimtest.js [leoId] [pointId] [safetyMs]
 *   例：node tools/race-aimtest.js 6 2035 40
 *
 * 预期：自动读榜一（2035=4900）→ 目标 4900+safety → 反推延迟 → 跑一局 → 核验上榜。
 */
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
const db = require('../src/db');
const jobs = require('../src/jobs');
const ss = require('../src/school-season');
db.init();
const leoId = Number(process.argv[2] || 6);
const pointId = Number(process.argv[3] || 2035);
const safety = Number(process.argv[4] || 40);
let acc = null;
for (const u of db.listUsers()) {
  const hit = db.listLeoAccounts(u.id).find((a) => Number(a.id) === leoId);
  if (hit) { acc = hit; break; }
}
if (!acc) { console.error('账号不存在'); process.exit(2); }
const jar = jobs.jarOf(acc);
(async () => {
  console.log(`=== 贴限模式实测（账号 ${acc.id}，point=${pointId}，safety=${safety}ms）===`);
  const t0 = Date.now();
  const res = await ss.runOneRace(jar, {
    pointId,
    grade: Number(acc.grade) || 2,
    aimCostMode: true,
    aimSafetyMs: safety,
    useSample: true,
    battleMaxMs: 4 * 60 * 1000,
  }, (ev) => {
    if (['ss-home-ok', 'ss-aim', 'ss-matched', 'ss-finish', 'ss-aim-ok', 'ss-aim-fail', 'ss-aim-warn', 'ss-warn', 'ss-gate'].includes(ev.type)) {
      console.log(`  [${(Date.now() - t0) / 1000 | 0}s] ${ev.message}`);
    }
  });
  console.log(`\n  → 结论：${res.ok ? `rank=${res.rank}/8, costTime=${res.costTimeMs}ms` : '失败 ' + res.message}`);
  console.log(`  → aim: ${JSON.stringify(res.aim)}`);
  console.log(`  → aimAccepted: ${res.aimAccepted}`);
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });