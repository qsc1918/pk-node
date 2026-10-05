'use strict';
/**
 * race-aim.js —— 「贴上榜下限」瞄准实验：跑指定延迟的一局，然后查该榜 self 状态。
 *
 * 用法：node tools/race-aim.js [leoId] [pointId] [delayMs] [skewMs]
 *   例：node tools/race-aim.js 6 2035 309
 *   例：node tools/race-aim.js 6 2039 0 427   # 秒答 + ts 偏移实验
 *
 * 输出：局结果（costTime/rank）+ 该榜当前榜一 + self 对比。
 */
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
const db = require('../src/db');
const jobs = require('../src/jobs');
const ss = require('../src/school-season');
db.init();
const leoId = Number(process.argv[2] || 6);
const pointId = Number(process.argv[3] || 2035);
const delayMs = Number(process.argv[4] || 0);
const skewMs = Number(process.argv[5] || 0);
let acc = null;
for (const u of db.listUsers()) {
  const hit = db.listLeoAccounts(u.id).find((a) => Number(a.id) === leoId);
  if (hit) { acc = hit; break; }
}
if (!acc) { console.error('账号不存在'); process.exit(2); }
const jar = jobs.jarOf(acc);
(async () => {
  console.log(`=== 瞄准实验（账号 ${acc.id}，point=${pointId}，delay=${delayMs}ms，skew=${skewMs}ms）===`);
  // 1) 先看榜现状
  const r0 = await ss.rank(jar, { pointId, scope: 1 });
  const d0 = r0.json || {};
  const ranks0 = Array.isArray(d0.ranks) ? d0.ranks : [];
  const min0 = ranks0.length ? Math.min(...ranks0.map((x) => x.costTime || 1e9)) : null;
  console.log(`  开跑前：榜一 costTime=${min0}ms（榜 ${ranks0.length} 人）`);

  // 2) 跑一局（固定延迟）
  const t0 = Date.now();
  const res = await ss.runOneRace(jar, {
    pointId,
    grade: Number(acc.grade) || 2,
    answerDelayMinMs: delayMs,
    answerDelayMaxMs: delayMs,
    answerTsSkewMs: skewMs,
    useSample: true,
    battleMaxMs: 4 * 60 * 1000,
  }, (ev) => {
    if (['ss-home-ok', 'ss-matched', 'ss-finish', 'ss-warn', 'ss-gate'].includes(ev.type)) {
      console.log(`  [${(Date.now() - t0) / 1000 | 0}s] ${ev.message}`);
    }
  });
  console.log(`  → 局结果：${res.ok ? `rank=${res.rank}/8, costTime=${res.costTimeMs}ms` : '失败 ' + res.message}`);

  // 3) 再查榜（self 状态）
  await new Promise((r) => setTimeout(r, 2000));
  const r1 = await ss.rank(jar, { pointId, scope: 1 });
  const d1 = r1.json || {};
  const ranks1 = Array.isArray(d1.ranks) ? d1.ranks : [];
  const min1 = ranks1.length ? Math.min(...ranks1.map((x) => x.costTime || 1e9)) : null;
  console.log(`  结算后：榜一 costTime=${min1}ms（榜 ${ranks1.length} 人）`);
  console.log(`  self=${JSON.stringify(d1.self)}`);
  const selfRank = d1.self && d1.self.rank;
  console.log(`\n  => ${selfRank === 999 ? '❌ 未上榜（低于该榜下限）' : `✅ 上榜 rank=${selfRank}（costTime=${d1.self && d1.self.costTime}）`}`);
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
