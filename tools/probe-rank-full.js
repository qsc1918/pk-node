'use strict';
/**
 * probe-rank-full.js —— 把某知识点的**完整榜单**打出来（前 15 + 后 5 + self）。
 *
 * 目的：验证一个关键矛盾 ——
 *   账号 6 在 2039 的 4934ms 被判"上榜"，但该榜榜一显示 5600ms。
 *   若 4934 真在榜上，榜一就该是 4934。所以要么榜单缓存、要么"上榜"另有含义。
 */
process.chdir('/root/pk-node');
const db = require('../src/db');
const jobs = require('../src/jobs');
const ss = require('../src/school-season');
db.init();

const leoId = Number(process.argv[2] || 6);
const pointId = Number(process.argv[3] || 2039);
let acc = null;
for (const u of db.listUsers()) {
  const hit = db.listLeoAccounts(u.id).find((a) => Number(a.id) === leoId);
  if (hit) { acc = hit; break; }
}
const jar = jobs.jarOf(acc);

(async () => {
  const r = await ss.rank(jar, { pointId, scope: 1 });
  const d = r.json || {};
  const ranks = d.ranks || [];
  console.log('=== [' + pointId + '] ' + d.curPointName + ' | scope=' + d.scope + ' | 条目=' + ranks.length + ' ===');
  console.log('--- 前 15 名 ---');
  for (const x of ranks.slice(0, 15)) {
    const p = x.player || {};
    console.log('  #' + String(x.rank).padStart(3) + '  costTime=' + String(x.costTime).padStart(6) +
      '  gap=' + x.gapCostTime + '  ' + (p.name || '').slice(0, 12) + (x.self ? '   ← 我' : ''));
  }
  console.log('--- 后 5 名 ---');
  for (const x of ranks.slice(-5)) {
    const p = x.player || {};
    console.log('  #' + String(x.rank).padStart(3) + '  costTime=' + String(x.costTime).padStart(6) +
      '  ' + (p.name || '').slice(0, 12) + (x.self ? '   ← 我' : ''));
  }
  console.log('--- self ---');
  console.log('  ' + JSON.stringify(d.self));
  // 找我在 ranks 里的位置
  const mine = ranks.filter((x) => x.self);
  console.log('--- 我在 ranks 中的行 ---');
  console.log('  ' + (mine.length ? JSON.stringify(mine) : '（不在前 100 里）'));
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });