'use strict';
/**
 * race-sweep.js —— 开学季竞速「最优配置」扫描。
 *
 * 思路：固定其他变量，逐组跑「提交时间」档位，收集每局的服务端 costTime 与名次，
 * 输出对照表（用于回答「什么配置最优」）。
 *
 * 用法：
 *   node tools/race-sweep.js [leoId] [runsPerCase]
 *   （默认账号 6、每档 2 局；跑完输出汇总表）
 *
 * ⚠️ 会真实提交对局（消耗账号的活动局数），请控制 runsPerCase 总量。
 */

const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));

const db = require('../src/db');
const jobs = require('../src/jobs');
const ss = require('../src/school-season');
db.init();

const leoId = Number(process.argv[2] || 6);
const runsPerCase = Math.max(1, Number(process.argv[3] || 2));

let acc = null;
for (const u of db.listUsers()) {
  const hit = db.listLeoAccounts(u.id).find((a) => Number(a.id) === leoId);
  if (hit) { acc = hit; break; }
}
if (!acc) { console.error('账号不存在'); process.exit(2); }
const jar = jobs.jarOf(acc);

/** 档位：提交延迟（ms）组合。 */
const CASES = [
  { label: '秒答(0~0)', min: 0, max: 0 },
  { label: '极快(20~60)', min: 20, max: 60 },
  { label: '快(50~150)', min: 50, max: 150 },
  { label: '中(300~600)', min: 300, max: 600 },
  { label: '慢(800~1500)', min: 800, max: 1500 },
];

(async () => {
  console.log(`=== 竞速最优配置扫描（账号 ${acc.id} ${acc.name}，每档 ${runsPerCase} 局）===`);
  const results = [];

  for (const c of CASES) {
    for (let r = 0; r < runsPerCase; r++) {
      const t0 = Date.now();
      const res = await ss.runOneRace(jar, {
        grade: Number(acc.grade) || 2,
        pointId: 0,
        answerDelayMinMs: c.min,
        answerDelayMaxMs: c.max,
        useSample: true,
        battleMaxMs: 4 * 60 * 1000,
      }, (ev) => {
        // 只打印关键节点，避免刷屏
        if (['ss-home-ok', 'ss-matched', 'ss-finish', 'ss-warn', 'ss-gate'].includes(ev.type)) {
          console.log(`  [${c.label} #${r + 1}] ${ev.message}`);
        }
      });
      const row = {
        case: c.label,
        run: r + 1,
        ok: res.ok,
        rank: res.rank,
        costTime: res.costTimeMs,
        wallMs: Date.now() - t0,
        message: res.message,
      };
      results.push(row);
      console.log(`  → ${c.label} #${r + 1}: ${res.ok ? `名次 ${res.rank}/8, costTime=${res.costTimeMs}ms` : '失败: ' + res.message}`);
      // 局间稍等，避免打爆
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  console.log('\n\n=== 汇总表 ===');
  console.log('档位'.padEnd(16) + '局数'.padEnd(6) + '成功率'.padEnd(8) + '平均名次'.padEnd(10) + '平均costTime'.padEnd(14) + '备注');
  for (const c of CASES) {
    const rows = results.filter((r) => r.case === c.label);
    const okRows = rows.filter((r) => r.ok && r.rank != null);
    const successRate = rows.length ? (rows.filter((r) => r.ok).length / rows.length * 100).toFixed(0) + '%' : '-';
    const avgRank = okRows.length ? (okRows.reduce((s, r) => s + r.rank, 0) / okRows.length).toFixed(2) : '-';
    const avgCost = okRows.length ? Math.round(okRows.reduce((s, r) => s + (r.costTime || 0), 0) / okRows.length) + 'ms' : '-';
    console.log(
      c.label.padEnd(16) + String(rows.length).padEnd(6) + successRate.padEnd(8) +
      String(avgRank).padEnd(10) + String(avgCost).padEnd(14) +
      (c.label === '秒答(0~0)' ? '← 预期最优（成本最低、名次最快）' : ''),
    );
  }
  process.exit(0);
})().catch((e) => {
  console.error('扫描异常:', e && e.stack || e);
  process.exit(1);
});
