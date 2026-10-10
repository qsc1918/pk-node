#!/usr/bin/env node
'use strict';
/**
 * 复核「出题冷却」到底是 1 秒还是 58 秒 —— 这决定能不能回到 1.3s/轮。
 *
 * ## 为什么必须查
 *   仓库历史 `fe6f0e0`（2026-10-01）写着：
 *
 *     「出题冷却实测 **约 1 秒/账号**（2026-10-01 复测：连续出题 4 次全 200，
 *       旧的「62 秒硬限流」已作废）」
 *
 *   而 2026-10-08 我用轮询实测得到 **约 58 秒**。
 *   两种可能：
 *     A) 服务端**改回去了**（10-01 短暂放开，之后收紧）
 *     B) 我的测法有问题（例如把「提交」的冷却误当成「出题」的）
 *
 *   这直接决定「1.3s/轮」是能做到还是做不到，必须查清。
 *
 * ## 本实验（不提交、只出题 —— 隔离出变量）
 *   连续出题 8 次，每次记录「距上次出题成功」的间隔与状态码。
 *   全程**不提交**，这样任何等待都只能归因于「出题」本身。
 *
 *   两条对照腿：
 *     ① 零间隔连发（不等待，立刻下一次）
 *     ② 每次间隔 1.2s（模拟「1.3s/轮」的节奏）
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 235001);
const NQ = Number(process.argv[4] || 100);
const ROUNDS = Number(process.argv[5] || 8);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(86)); line(t); line('='.repeat(86)); }

/** 发起一次出题，返回 {status, text, ms} */
async function tryMatch(jar) {
  const t = Date.now();
  const g = await exercise.getExam(jar, KP, NQ, {});
  return { status: g.status, text: String(g.text || ''), ms: Date.now() - t };
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 ' + acc.id + '  知识点 ' + KP + '  题数 ' + NQ + '  轮数 ' + ROUNDS);
  line('★ 全程**不提交**，只看「出题」的冷却');

  hr('① 腿一：零间隔连发（立刻打下一次）');
  let lastOk = 0;
  for (let i = 1; i <= ROUNDS; i++) {
    const r = await tryMatch(jar);
    const gap = lastOk ? (Date.now() - lastOk) : 0;
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('  第 ' + i + ' 次  ' + tag
      + '  距上次成功 ' + (gap / 1000).toFixed(2) + 's'
      + '  本次耗时 ' + (r.ms / 1000).toFixed(2) + 's'
      + (r.status !== 200 ? '  ' + r.text.slice(0, 60).replace(/\s+/g, ' ') : ''));
    if (r.status === 200) lastOk = Date.now();
    else await sleep(200);          // 失败也不多等，尽快探到放行点
  }

  hr('② 腿二：每次间隔 1.2s（模拟 1.3s/轮 的节奏）');
  let lastOk2 = 0;
  for (let i = 1; i <= ROUNDS; i++) {
    if (lastOk2) {
      const need = 1200 - (Date.now() - lastOk2);
      if (need > 0) await sleep(need);
    }
    const r = await tryMatch(jar);
    const gap = lastOk2 ? (Date.now() - lastOk2) : 0;
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('  第 ' + i + ' 次  ' + tag
      + '  距上次成功 ' + (gap / 1000).toFixed(2) + 's'
      + (r.status !== 200 ? '  ' + r.text.slice(0, 60).replace(/\s+/g, ' ') : ''));
    if (r.status === 200) lastOk2 = Date.now();
  }

  hr('判定');
  line('  若两条腿都在 1~2s 内连续 200 ⇒ 冷却确实只有 ~1s（历史文案成立），');
  line('     那 1.3s/轮 可做到，我此前的 58s 测法有问题。');
  line('  若连发大量 429、需等几十秒 ⇒ 冷却已被服务端收紧，');
  line('     1.3s/轮 已不可得（只能靠多账号并行）。');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });