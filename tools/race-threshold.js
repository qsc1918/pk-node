'use strict';
/**
 * race-threshold.js —— 「4900ms 上榜下限」取证分析。
 *
 * 问题（用户报告）：服务器最低接受上榜 costTime 4900ms，我们的秒答局（costTime 1829ms）不上榜。
 *
 * 分析角度：
 *  1. 榜单数据里最小 costTime 是多少？（确认 4900 天花板）
 *  2. 我们 self.rank=999 且 self.costTime=4829 —— 低于 4900 就被排除？
 *  3. 尝试多个知识点看门槛是否一致（排除「只是数据巧合」）。
 *  4. 读取服务端返回的原始字段（找排名字段外的线索）。
 */
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));

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
if (!acc) { console.error('账号不存在'); process.exit(2); }
const jar = jobs.jarOf(acc);

(async () => {
  console.log('=== 1) 活动主页（全部知识点）===');
  const h = await ss.home(jar, { grade: acc.grade || 2 });
  const points = (h.json && h.json.points) || [];
  for (const p of points) console.log(`  ${p.pointId} ${p.pointName} (${p.expectedQuestionCnt} 题)`);

  console.log('\n=== 2) 逐知识点查榜单最小值 + 我的位置 ===');
  for (const p of points) {
    const r = await ss.rank(jar, { pointId: p.pointId, scope: 1 });
    const d = r.json || {};
    const ranks = Array.isArray(d.ranks) ? d.ranks : [];
    const costs = ranks.map((x) => x.costTime).filter((x) => typeof x === 'number');
    const min = costs.length ? Math.min(...costs) : null;
    const max = costs.length ? Math.max(...costs) : null;
    console.log(`  [${p.pointId}] ${p.pointName}: 榜 ${ranks.length} 人，costTime ${min}~${max}ms`);
    console.log(`      self: ${JSON.stringify(d.self)}`);
    // 找所有小于 4900 的
    const below = ranks.filter((x) => x.costTime < 4900);
    console.log(`      低于 4900ms 的: ${below.length} 人`);
  }

  console.log('\n=== 3) 原始 JSON（第一个知识点，完整 self 对象）===');
  const r1 = await ss.rank(jar, { pointId: points[0] && points[0].pointId, scope: 1 });
  console.log('keys:', Object.keys(r1.json || {}));
  console.log('self:', JSON.stringify((r1.json || {}).self, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });