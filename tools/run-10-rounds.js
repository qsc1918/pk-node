#!/usr/bin/env node
'use strict';
/**
 * 本地跑 10 局练习（出题 → 抄答案 → 提交 → 拉批改）。
 *
 * 用法：
 *   node tools/run-10-rounds.js [leoAccountId] [limit] [rounds]
 * 默认：库里第一个可用账号、10 题/局、10 局。
 *
 * 判据：每局 HTTP 200 且服务端判对，说明换用 3.141.1 的新签名资产后链路已通。
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACCOUNT_ID = process.argv[2] ? Number(process.argv[2]) : null;
const LIMIT = process.argv[3] ? Number(process.argv[3]) : 10;
const ROUNDS = process.argv[4] ? Number(process.argv[4]) : 10;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

(async () => {
  db.init();

  const all = [];
  for (const appUserId of [1, 2, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19]) {
    try {
      const list = db.listLeoAccounts(appUserId) || [];
      for (const a of list) all.push(a);
    } catch (e) { /* 忽略 */ }
  }
  console.log('库里可用小猿账号: %d 个' % all.length);
  if (!all.length) {
    console.error('没有可用账号（先在管理后台导入登录态）');
    process.exit(1);
  }

  let acc = null;
  if (ACCOUNT_ID != null) {
    acc = all.find((a) => Number(a.id) === ACCOUNT_ID) || db.getLeoAccount(ACCOUNT_ID);
    if (!acc) {
      console.error('找不到账号 id=' + ACCOUNT_ID);
      process.exit(1);
    }
  } else {
    acc = all[0];
  }

  console.log('选用账号: id=%s name=%s yfd_u=%s', acc.id, acc.name || '(无名)', acc.yfd_u || '');
  console.log('每局题数: %d   局数: %d', LIMIT, ROUNDS);
  console.log('='.repeat(78));

  const jar = jobs.jarOf(acc);

  // 1) 先读一次当前分数（探活 + 基线）
  let before = null;
  try {
    before = await exercise.readScore(jar);
    console.log('[%s] 基线 curWeekScore = %s', ts(), before);
  } catch (e) {
    console.log('[%s] 读分数异常: %s', ts(), e.message);
  }
  if (before === null) {
    console.log('⚠️  读不到分数 —— cookie 可能已失效，或该端点被拦。继续试跑。');
  }
  console.log('='.repeat(78));

  let ok = 0, fail = 0, totalExp = 0;
  const t0 = Date.now();
  const detail = [];

  for (let i = 1; i <= ROUNDS; i++) {
    const rt = Date.now();
    let r;
    try {
      r = await exercise.runPractice(jar, {
        keypointId: 235001,
        limit: LIMIT,
        onEvent: (ev) => {
          if (ev.type && (ev.type.startsWith('ex-match') || ev.type.startsWith('ex-fail') ||
                          ev.type === 'ex-rate-limit')) {
            console.log('      [%s] %s', ts(), ev.message);
          }
        },
      });
    } catch (e) {
      r = { ok: false, text: '异常：' + e.message };
    }

    const sec = ((Date.now() - rt) / 1000).toFixed(1);
    if (r && r.ok) {
      ok++;
      totalExp += r.exp || 0;
      console.log('[%s] 第 %d/%d 局 ✓  examId=%s  判对 %d/%d  +%d 经验  (%ss)',
        ts(), i, ROUNDS, r.examId, r.correctCnt, r.questionCnt, r.exp, sec);
      detail.push({ round: i, ok: true, correct: r.correctCnt, total: r.questionCnt, exp: r.exp, sec: Number(sec) });
    } else {
      fail++;
      console.log('[%s] 第 %d/%d 局 ✗  %s  (%ss)',
        ts(), i, ROUNDS, String((r && (r.text || r.message)) || '未知失败').slice(0, 140), sec);
      detail.push({ round: i, ok: false, stage: r && r.stage, status: r && r.status,
                    text: String((r && r.text) || '').slice(0, 200), sec: Number(sec) });
    }

    // 局间留点间隔，避免贴边撞 429（出题冷却约 1s）
    if (i < ROUNDS) await new Promise((res) => setTimeout(res, 1200));
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(1);

  // 2) 再读一次分数
  let after = null;
  try { after = await exercise.readScore(jar); } catch (e) { /* 忽略 */ }

  console.log('='.repeat(78));
  console.log('完成：成功 %d / 失败 %d / 共 %d 局，总耗时 %ss', ok, fail, ROUNDS, dur);
  console.log('本批共获得经验: +%d', totalExp);
  if (before !== null || after !== null) {
    console.log('服务端周分数: %s → %s', before, after);
    if (before != null && after != null) console.log('  实际入账: %s', (after - before));
  }

  // 3) 汇总失败原因
  const fails = detail.filter((d) => !d.ok);
  if (fails.length) {
    console.log();
    console.log('失败明细:');
    const byStage = {};
    for (const f of fails) {
      const k = (f.stage || 'unknown') + ' HTTP ' + (f.status || '-');
      byStage[k] = (byStage[k] || 0) + 1;
      console.log('  第 ' + f.round + ' 局: ' + k + '  ' + (f.text || ''));
    }
    console.log();
    console.log('按阶段汇总:');
    for (const k of Object.keys(byStage)) console.log('  ' + k.padEnd(28) + ' ' + byStage[k] + ' 次');
  }

  require('node:fs').writeFileSync('/tmp/run10-result.json',
    JSON.stringify({ accountId: acc.id, limit: LIMIT, rounds: ROUNDS, ok, fail,
                     totalExp, before, after, dur, detail }, null, 1));
  console.log();
  console.log('结果已存 /tmp/run10-result.json');
  process.exit(fail && !ok ? 1 : 0);
})().catch((e) => {
  console.error('跑手异常:', (e && e.stack) || e);
  process.exit(1);
});