#!/usr/bin/env node
'use strict';
/**
 * 决定性实验 ②：`math/pk/match/v2` 的 417 到底缺什么？
 *
 * ## 已知
 *   同一个 `variant:'pk'` 资产下：
 *     · GET  game/battle/v2/math/home  → 200 ✅
 *     · POST math/pk/match/v2          → 417 ❌
 *   两者都属 `/leo-game-pk`，却一个放行一个拦。
 *
 * ## 待验假设（逐个排除）
 *   A. **variant 选错了** —— v2 需要另一套（exercise 或 lre_pk.so）
 *   B. **缺 `x-shepherd-did`** —— 真机 348 次全带该头（设备标识）
 *   C. **version 参数错** —— PK 表与练习表不同
 *   D. **public 参数组合不对** —— 少了 webviewVersion/whRatio 等
 *
 * ## 做法
 *   矩阵式试：variant × 带头 × version，看哪组合能出 200 / 非 417。
 *   每格只改一个变量，结论可归因。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const leo = require(path.join(ROOT, 'src', 'leo'));
const nativeLib = require(path.join(ROOT, 'src', 'native.js'));
const { request } = require(path.join(ROOT, 'src', 'http'));

const ACC_ID = Number(process.argv[2] || 15);
const PK_PATH = '/leo-game-pk/android/math/pk/match/v2';
const HOST = 'https://xyks.yuanfudao.com';

function line(s) { console.log(s); }

/** 真机 x-shepherd-did（来自设备 mmkv didKey，值恒定）。 */
const REAL_DID = process.env.PK_DID || 'DUtA-DmaWBaa-xgaLMMFCl5fjJG__ajuzNf3';

function qsOf(obj) {
  return Object.keys(obj)
    .filter((k) => obj[k] != null)
    .map((k) => k + '=' + encodeURIComponent(obj[k]))
    .join('&');
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号 ' + ACC_ID); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 id=' + acc.id + '  yfd_u=' + acc.yfd_u);
  line('');

  /** 公共参数模板。 */
  const base = {
    pointId: '2005',
    triggerPeakMatch: '0',
    _productId: '611',
    platform: 'android37',
    vendor: 'UC',
    deviceCategory: 'phone',
    av: '5',
    webviewVersion: '150',
    whRatio: '2.17',
    isBackground: '1',
  };

  const cases = [];
  for (const variant of ['pk', 'exercise']) {
    for (const version of ['3.141.1', '3.143.1']) {
      for (const did of [false, true]) {
        cases.push({ variant, version, did });
      }
    }
  }

  const results = [];
  line('='.repeat(96));
  line('矩阵实验：POST ' + PK_PATH);
  line('='.repeat(96));
  line('  variant   version   did       → HTTP  提示');
  line('  ' + '-'.repeat(90));

  for (const c of cases) {
    const q = Object.assign({}, base, { version: c.version });
    let sign;
    try {
      sign = nativeLib.calcSign(PK_PATH, { variant: c.variant });
    } catch (e) {
      line('  ' + c.variant.padEnd(9) + c.version.padEnd(10) + '?        → 算 sign 失败: ' + e.message);
      continue;
    }
    const url = HOST + PK_PATH + '?' + qsOf(q) + '&sign=' + sign;
    const headers = Object.assign({}, leo.riskHeaders(), {
      'Content-Type': 'application/json',
    });
    if (c.did) headers['x-shepherd-did'] = REAL_DID;

    let status = 'ERR';
    let msg = '';
    try {
      const r = await request({ url, method: 'POST', jar, headers, body: '', timeoutMs: 20000 });
      status = r.status;
      const blk = (r.headers && (r.headers['x-block-by'] || r.headers['X-Block-By'])) || '';
      msg = String(r.text || '').replace(/\s+/g, ' ').slice(0, 90);
      if (blk) msg = '[x-block-by:' + blk + '] ' + msg;
    } catch (e) {
      msg = e.message;
    }
    results.push({ c, status, msg });
    const mark = (status === 200 ? ' ✅' : (status === 417 ? ' ❌417' : ''));
    line('  ' + c.variant.padEnd(9) + c.version.padEnd(10)
      + (c.did ? 'yes' : 'no ').padEnd(10) + '→ ' + String(status).padEnd(6) + mark + '  ' + msg);
  }

  line('');
  line('='.repeat(96));
  line('判定');
  line('='.repeat(96));
  const ok = results.filter((r) => r.status === 200);
  const not417 = results.filter((r) => r.status !== 417 && r.status !== 'ERR');
  if (ok.length) {
    line('  ✅ 有 ' + ok.length + ' 个组合拿到 200：');
    ok.forEach((r) => line('     variant=' + r.c.variant + ' version=' + r.c.version + ' did=' + r.c.did));
  } else if (not417.length) {
    line('  ⚠️ 没有 200，但有不返回 417 的组合（说明 sign 已过，是别的错）：');
    not417.forEach((r) => line('     variant=' + r.c.variant + ' version=' + r.c.version
      + ' did=' + r.c.did + ' → ' + r.status + '  ' + r.msg));
  } else {
    line('  ❗ 全部 417 —— sign 本身不被接受。');
    line('     结论：v2 端点的 sign 不是这两套资产中的任何一套能算出的，');
    line('     或服务端对 v2 有额外的校验维度（如 body 签名、时间窗口）。');
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });