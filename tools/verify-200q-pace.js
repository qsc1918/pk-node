#!/usr/bin/env node
'use strict';
/**
 * 验证「200 题」下的等待量是否符合两个模式，并确认旧文案已消失。
 *
 * ## 背景
 *   用户看到 `按声明耗时等待 180.3s` —— 那是**旧代码**的输出：
 *     180s = 200 题 × 900ms（我第一版「等待 = 声明总耗时」的算法）
 *   原因：服务进程 `node bin/start.js` 已跑 1 小时 8 分，
 *   而我在此之后做了 3 次提交（d21d090 / 2dbb19f / 9bee228）——
 *   Node 不热重载，进程加载的始终是启动那一刻的代码。
 *
 *   现已重启（8792）。本脚本用**真实生产路径**确认新逻辑：
 *     rank  200 题 → 需 ≥ 0.5 + 200×0.5 = 100.5s
 *     speed 200 题 → 需 ≥ 0.3 + 200×0.2 = 40.3s
 *
 *   同时断言：输文案里**不再出现**「按声明耗时等待」。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 235001);
const NQ = Number(process.argv[4] || 200);

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(84)); line(t); line('='.repeat(84)); }

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);

  hr('① 纯计算：200 题下两个模式各需等多久（不发请求）');
  for (const mode of ['speed', 'rank']) {
    const p = exercise.resolveSubmitPace({ submitPaceMode: mode });
    const need = p.padMs + NQ * p.perQMs;
    line('  ' + mode.padEnd(6) + ' ' + p.label.padEnd(22)
      + ' ' + p.perQMs + 'ms/题 × ' + NQ + ' + 余量 ' + p.padMs + 'ms'
      + '  ⇒ 需 ≥ ' + (need / 1000).toFixed(1) + 's');
  }
  line('');
  line('  对照：用户看到的 180.3s = 200 × 900ms + 300ms（旧算法，已废弃）');

  hr('② 真实跑一轮（' + NQ + ' 题，默认模式）');
  line('  注意：出题冷却约 58s，可能要等；这里只观察「等待文案」与结果。');
  const t0 = Date.now();
  const seen = [];
  const r = await exercise.runPractice(jar, {
    keypointId: KP,
    limit: NQ,
    onEvent: (ev) => {
      if (!ev || !ev.message) return;
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      if (ev.type === 'ex-rate-limit') { line('  [' + dt + 's] ' + ev.message); return; }
      if (ev.type === 'ex-match-ok' || ev.type === 'ex-pace' || ev.type === 'ex-ok' || ev.type === 'ex-fail') {
        seen.push(ev.message);
        line('  [' + dt + 's] ' + ev.message);
      }
    },
  });

  hr('③ 断言');
  const paceMsg = seen.find((m) => m.indexOf('后提交') >= 0) || '';
  const hasOld = /按声明耗时等待/.test(paceMsg);
  const hasNew = /ms\/题 × \d+ 题/.test(paceMsg);
  line('  等待文案: ' + (paceMsg || '（未出现）'));
  line('  含旧文案「按声明耗时等待」: ' + (hasOld ? '❌ 是（仍在跑旧代码！）' : '✅ 否'));
  line('  含新文案「Nms/题 × M 题」 : ' + (hasNew ? '✅ 是' : '（本轮未触发等待则为空）'));
  line('');
  line('  本轮结果: ' + (r && r.ok ? '✅ 成功 判对 ' + r.correctCnt + '/' + r.questionCnt + '  +' + r.exp + ' 经验'
    : '❌ 失败 ' + ((r && r.stage) || '') + ' ' + ((r && r.status) || '')));
  line('  总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });