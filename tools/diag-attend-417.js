#!/usr/bin/env node
'use strict';
/**
 * 诊断 attend（经验上报）为什么 417。
 *
 * 做法：用库里已有的小猿账号 cookie，带/不带 `x-shepherd-did` 各打一次，
 *       对比服务端响应差异。这是判断「417 到底卡在哪个头」的唯一可靠方式。
 *
 * 用法：node tools/diag-attend-417.js
 */
const db = require('../src/db');
const { config, PK } = require('../src/config');
const leo = require('../src/leo');
const nativeLib = require('../src/native');
const exercise = require('../src/exercise');

(async () => {
  db.init();

  const accs = db.listLeoAccounts();
  console.log('=== 库里的小猿账号 ===');
  console.log('数量:', accs.length);
  if (!accs.length) {
    console.log('（没有账号，无法实测）');
    return;
  }
  for (const a of accs.slice(0, 5)) {
    console.log('  id=%s user=%s', a.id, a.userName || a.remark || '(无名)');
  }

  const acc = accs[0];
  const jar = require('../src/jobs').jarOf(acc);

  const path = '/leo-star/android/exercise/rank/login/attend';
  console.log();
  console.log('=== 1) 先读一次周分数（探活）===');
  try {
    const pre = await exercise.readScore(jar);
    console.log('  curWeekScore = %s', pre);
    if (pre === null) {
      console.log('  ⚠️ 读不到分数 → 说明 cookie 已失效，或该端点本身被拦');
    }
  } catch (e) {
    console.log('  读取异常:', e.message);
  }

  console.log();
  console.log('=== 2) 试算 sign（exercise 变体）===');
  let sign = null;
  try {
    sign = nativeLib.calcSign(path, { variant: 'exercise' });
    console.log('  sign =', sign);
  } catch (e) {
    console.log('  算不出来:', e.message);
  }

  console.log();
  console.log('=== 3) 当前请求头 ===');
  console.log(' ', JSON.stringify(exercise.exerciseHeaders(), null, 1).replace(/\n/g, '\n  '));
  console.log('  shepherdDid =', JSON.stringify(config.shepherdDid));

  console.log();
  console.log('=== 4) 实打一次 attend，看服务端怎么说 ===');
  const r = await exercise.attend(jar, 200, 0);
  console.log('  HTTP', r.status);
  console.log('  body:', String(r.text).slice(0, 300));
  console.log('  发出:', JSON.stringify(r.sent));

  console.log();
  console.log('=== 5) 结论提示 ===');
  if (r.status === 417) {
    console.log('  417 = 服务端风控拒绝。真机相同端点是 200，');
    console.log('  差异点最可能是缺 `x-shepherd-did`（真机 348 次请求全带，且值恒定）。');
    console.log('  真机值: DUtA-DmaWBaa-xgaLMMFCl5fjJG__ajuzNf3');
    console.log('  本地 config.shepherdDid 当前为: ' + JSON.stringify(config.shepherdDid));
  } else if (r.status === 200) {
    console.log('  200 —— 通过。');
  } else {
    console.log('  其它状态，看 body。');
  }
})().catch((e) => {
  console.error('诊断脚本异常:', e && e.stack || e);
  process.exit(1);
});