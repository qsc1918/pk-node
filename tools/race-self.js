'use strict';
/**
 * race-self.js —— 快速查看「我们自己在竞速榜单上的位置」+ 榜单全貌。
 *
 * 用法：node tools/race-self.js [leoId] [pointId]
 */
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));

const db = require('../src/db');
const jobs = require('../src/jobs');
const ss = require('../src/school-season');
db.init();

const leoId = Number(process.argv[2] || 6);
const pointIdArg = Number(process.argv[3] || 0);

let acc = null;
for (const u of db.listUsers()) {
  const hit = db.listLeoAccounts(u.id).find((a) => Number(a.id) === leoId);
  if (hit) { acc = hit; break; }
}
if (!acc) { console.error('账号不存在'); process.exit(2); }
const jar = jobs.jarOf(acc);

(async () => {
  const h = await ss.home(jar, { grade: acc.grade || 2 });
  const pointId = pointIdArg || (h.json && h.json.points && h.json.points[0] && h.json.points[0].pointId) || 0;
  const r = await ss.rank(jar, { pointId, scope: 1 });
  const d = r.json || {};
  const ranks = Array.isArray(d.ranks) ? d.ranks : [];
  console.log('=== 榜单 ===');
  console.log('知识点:', d.curPointName, '| 总数:', ranks.length, '| 我:', JSON.stringify(d.self));
  console.log('\n前 5：');
  for (const x of ranks.slice(0, 5)) {
    console.log(`  #${x.rank} ${x.costTime}ms ${x.player && x.player.name}${x.self ? '  ← 我' : ''}`);
  }
  console.log('\n后 5：');
  for (const x of ranks.slice(-5)) {
    console.log(`  #${x.rank} ${x.costTime}ms ${x.player && x.player.name}`);
  }
  const mineRow = ranks.filter((x) => x.self || (x.player && String(x.player.id) === String(acc.yfd_u)));
  console.log('\n我在榜上的行:', mineRow.length ? JSON.stringify(mineRow) : '（不在榜）');
  // costTime 分布直方
  const buckets = {};
  for (const x of ranks) {
    const b = Math.floor((x.costTime || 0) / 100) * 100;
    buckets[b] = (buckets[b] || 0) + 1;
  }
  console.log('\ncostTime 分布（100ms 桶）:', JSON.stringify(buckets));
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });