#!/usr/bin/env node
'use strict';
/**
 * 验证「上榜模式」两档系数是否如实测所述。
 *
 * ## 待验
 *   · `fast` 0.2s/题 → 提交应通过 200
 *   · `rank` 0.5s/题 → 提交应通过 200（且结算时间卡到 0.5s/题）
 *
 * ## 做法
 *   用**真实生产路径**（runPractice）跑，而不是手搓 body，
 *   这样连「等待逻辑 + 声明值 + 提交」一起验。
 *
 *   题数取 20（阈值已知在 3~5s 附近，两档差别明显）：
 *     20 题 fast = 0.5 + 20×0.2 = 4.5s
 *     20 题 rank = 0.5 + 20×0.5 = 10.5s
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const NQ = Number(process.argv[4] || 20);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 ' + acc.id + '  知识点 ' + KP + '  题数 ' + NQ);

  for (const mode of ['fast', 'rank']) {
    hr('模式 ' + mode);
    const t0 = Date.now();
    const r = await exercise.runPractice(jar, {
      keypointId: KP,
      limit: NQ,
      submitPaceMode: mode,
      onEvent: (ev) => {
        if (ev && ev.type && (ev.type === 'ex-pace' || ev.type === 'ex-match-ok'
          || ev.type === 'ex-submit' || ev.type === 'ex-fail' || ev.type === 'ex-ok')) {
          line('  [' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + ev.message);
        }
      },
    });
    line('  → ' + (r && r.ok ? '✅ 成功' : '❌ 失败') + '  总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    if (r && r.ok) {
      line('     判对 ' + r.correctCnt + '/' + r.questionCnt + '  经验 +' + r.exp);
    } else if (r) {
      line('     stage=' + r.stage + ' status=' + r.status + ' ' + String(r.text || '').slice(0, 120));
    }
    await sleep(3000);
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });