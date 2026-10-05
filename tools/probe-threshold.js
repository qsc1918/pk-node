'use strict';
/**
 * probe-threshold.js —— 逐知识点榜单「完整取证」。
 *
 * 目的：客户指出「现在的下限有问题」——重新用**最新榜单数据**核对：
 *  - 榜一（= 之前认为的「下限」）
 *  - 榜尾（最小 costTime 的真实下界）
 *  - 排名分布、self 状态
 */
process.chdir('/root/pk-node');
const db = require('../src/db');
const jobs = require('../src/jobs');
const ss = require('../src/school-season');
db.init();

const leoId = Number(process.argv[2] || 6);
let acc = null;
for (const u of db.listUsers()) {
  const hit = db.listLeoAccounts(u.id).find((a) => Number(a.id) === leoId);
  if (hit) { acc = hit; break; }
}
if (!acc) { console.error('账号 ' + leoId + ' 不存在'); process.exit(2); }
const jar = jobs.jarOf(acc);

(async () => {
  const h = await ss.home(jar, { grade: acc.grade || 2 });
  const pts = (h.json && h.json.points) || [];
  console.log('=== 活动知识点：' + pts.length + ' 个（账号 ' + acc.id + ' grade=' + acc.grade + '）===');
  for (const p of pts) {
    const r = await ss.rank(jar, { pointId: p.pointId, scope: 1 });
    const d = r.json || {};
    const ranks = Array.isArray(d.ranks) ? d.ranks : [];
    const costs = ranks.map((x) => Number(x.costTime)).filter((x) => Number.isFinite(x));
    const min = costs.length ? Math.min.apply(null, costs) : null;
    const max = costs.length ? Math.max.apply(null, costs) : null;
    console.log('');
    console.log('[' + p.pointId + '] ' + p.pointName + ' | 默认题数=' + p.expectedQuestionCnt + ' | 榜 ' + ranks.length + ' 人');
    console.log('    costTime 区间: ' + min + ' ~ ' + max + 'ms');
    console.log('    self = ' + JSON.stringify(d.self));
    // 前 3 名（榜首）与后 3 名（榜尾）
    console.log('    前3 = ' + JSON.stringify(ranks.slice(0, 3).map((x) => ({ rank: x.rank, costTime: x.costTime, gap: x.gapCostTime }))));
    console.log('    后3 = ' + JSON.stringify(ranks.slice(-3).map((x) => ({ rank: x.rank, costTime: x.costTime, gap: x.gapCostTime }))));
    // 分布：按 100ms 桶统计（看是否有台阶/突变）
    const buckets = {};
    for (const c of costs) { const b = Math.floor(c / 500) * 500; buckets[b] = (buckets[b] || 0) + 1; }
    console.log('    分布(500ms桶) = ' + JSON.stringify(buckets));
  }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });