#!/usr/bin/env node
'use strict';
/**
 * 量准「出题 429 冷却」的真实时长 —— 这是当前真正的速度瓶颈。
 *
 * ## 为什么查
 *   10 局实测每局 64.7s，其中约 50s 是 429 重试等待。
 *   而代码里 `MATCH_RETRY_INTERVAL_MS = 10000`（写死 10s），
 *   `MATCH_COOLDOWN_MS = 1500`（1.5s）—— 两者自相矛盾。
 *
 *   若真实冷却远小于 10s，那每轮都白等几十秒；
 *   把重试间隔改小即可显著提速。
 *
 * ## 做法（轮询，1s 一跳）
 *   连续 4 轮：出题 → 提交 → 立刻开始下一轮出题并**每秒重试**，
 *   记录每次「从提交完成到出题成功」的真实等待。
 *   用 limit=10（提交本身只需约 2s），把测得的等待归因到出题冷却。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 235001);
const NQ = Number(process.argv[4] || 10);
const ROUNDS = Number(process.argv[5] || 4);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 每秒轮询出题，直到成功；返回 {res, waitMs, tries} */
async function matchPolling(jar, t0) {
  let tries = 0;
  for (;;) {
    const g = await exercise.getExam(jar, KP, NQ, {});
    tries++;
    if (g.status === 200) return { res: g, waitMs: Date.now() - t0, tries: tries };
    if (g.status !== 429) return { res: g, waitMs: Date.now() - t0, tries: tries };
    if (Date.now() - t0 > 180000) return { res: g, waitMs: Date.now() - t0, tries: tries };
    await sleep(1000);
  }
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 ' + acc.id + '  知识点 ' + KP + '  题数 ' + NQ + '  轮数 ' + ROUNDS);
  line('轮询间隔 1s（仅用于测量，不改生产配置）');
  line('');

  const rows = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const t0 = Date.now();
    const m = await matchPolling(jar, t0);
    if (!m.res || m.res.status !== 200) {
      line('第 ' + i + ' 轮：出题最终失败 ' + (m.res && m.res.status)
        + '  已等 ' + (m.waitMs / 1000).toFixed(1) + 's  试 ' + m.tries + ' 次');
      break;
    }
    const ex = m.res.json;
    const n = (ex.questions || []).length;

    // 用最省的等待提交（0.2s/题 + 0.3s 余量）
    const body = exercise.answerAll(ex, 200);
    const need = 300 + n * 200;
    const elapsed = Date.now() - (t0 + m.waitMs);
    if (need - elapsed > 0) await sleep(need - elapsed);
    const sub = await exercise.submitExam(jar, ex.idString, body, {});

    line('第 ' + i + ' 轮  出题等待 ' + (m.waitMs / 1000).toFixed(1) + 's（试 ' + m.tries + ' 次）'
      + '   提交 ' + sub.status
      + (sub.status === 200 ? '（判对 ' + ((sub.json || {}).correctCnt) + '/' + n + '）' : ''));
    rows.push({ round: i, matchWaitMs: m.waitMs, tries: m.tries, submit: sub.status });
  }

  line('');
  line('=== 汇总 ===');
  const waits = rows.filter((r) => r.round > 1).map((r) => r.matchWaitMs);
  if (waits.length) {
    const avg = waits.reduce((a, b) => a + b, 0) / waits.length;
    line('  第 2 轮起的出题等待: 平均 ' + (avg / 1000).toFixed(1) + 's'
      + '  最小 ' + (Math.min.apply(null, waits) / 1000).toFixed(1) + 's'
      + '  最大 ' + (Math.max.apply(null, waits) / 1000).toFixed(1) + 's');
    line('  ⇒ 当前生产把重试间隔写死 10s，若真实冷却 < 10s，');
    line('     则每轮至少白等 (10 - 真实冷却)。把间隔改小即可提速。');
  } else {
    line('  样本不足');
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });