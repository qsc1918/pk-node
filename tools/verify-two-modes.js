#!/usr/bin/env node
'use strict';
/**
 * 端到端验证「两个模式」+ 提速效果。
 *
 * ## 要验的
 *   ① 模式解析：rank（默认）500ms/题、speed 200ms/题
 *   ② 重试间隔：10s → 3s（每轮少白等）
 *   ③ 默认题数：拉满 200（同窗口收益 ×2）
 *   ④ 真实跑一轮 **rank**（默认模式）看是否判对
 *   ⑤ 真实跑一轮 **speed** 看是否更快、是否仍判对
 *
 * ⚠️ 出题冷却约 58s，两轮之间必然等待；这正是要展示的瓶颈。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 235001);
const NQ = Number(process.argv[4] || 20);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);

  hr('配置自检');
  const c = require(path.join(ROOT, 'src', 'config'));
  line('  默认模式       : ' + c.config.exerciseSubmitPace.defaultMode + '（主打上榜）');
  line('  模式表         : ' + Object.keys(c.config.exerciseSubmitPace.modes)
    .map((k) => k + '=' + c.config.exerciseSubmitPace.modes[k].perQMs + 'ms').join('  '));
  line('  重试轮询间隔   : ' + exercise.MATCH_RETRY_INTERVAL_MS + 'ms（旧 10000）');
  line('  默认每局题数   : ' + c.config.exerciseSpeed.defaultLimit + '（可拉满，收益×2）');

  hr('账号 ' + acc.id + '  知识点 ' + KP + '  题数 ' + NQ);

  for (const mode of ['rank', 'speed']) {
    line('');
    line('--- 模式 ' + mode + ' ---');
    const t0 = Date.now();
    let waitedShown = false;
    const r = await exercise.runPractice(jar, {
      keypointId: KP,
      limit: NQ,
      submitPaceMode: mode,
      onEvent: (ev) => {
        if (!ev || !ev.type) return;
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        if (ev.type === 'ex-rate-limit' && !waitedShown) {
          line('  [' + dt + 's] ' + ev.message);
          waitedShown = true;
        } else if (ev.type === 'ex-pace' || ev.type === 'ex-match-ok'
          || ev.type === 'ex-ok' || ev.type === 'ex-fail') {
          line('  [' + dt + 's] ' + ev.message);
        }
      },
    });
    const total = ((Date.now() - t0) / 1000).toFixed(1);
    line('  → ' + (r && r.ok ? '✅ 成功' : '❌ 失败') + '  本局耗时 ' + total + 's'
      + (r && r.ok ? '  判对 ' + r.correctCnt + '/' + r.questionCnt + '  +' + r.exp + ' 经验' : ''));
    if (r && !r.ok) line('     stage=' + r.stage + ' status=' + r.status + ' ' + String(r.text || '').slice(0, 110));
  }

  hr('结论');
  line('  两种模式都应判对（笔迹已修好）；差别只在「提交等待」的宽严：');
  line('    rank  500ms/题 —— 结算时间卡到位，用作上榜');
  line('    speed 200ms/题 —— 最快过提交，用作刷分');
  line('  吞吐瓶颈是出题冷却（约 58s/局），提速靠「题数拉满」或「多账号并行」。');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });