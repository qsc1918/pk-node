#!/usr/bin/env node
'use strict';
/**
 * 干净验证：确认「sign 与 version 绑定」这条规律，并找出 PK 的正确 pointId。
 *
 * ## 上一步的发现
 *   矩阵实验显示：
 *     pk       + 3.143.1 → 400（业务错）  ⇒ sign 通过
 *     exercise + 3.141.1 → 400（业务错）  ⇒ sign 通过
 *     交叉组合          → 417             ⇒ sign 失败
 *   ⇒ **服务端按 `version` 选签名算法**，版本与资产必须配对。
 *
 * ## 本步要做的（各自独立、间隔足够，避开频控）
 *   1. 单发 exercise+3.141.1 到 `pk/match/v2`，确认是 400 而非 417
 *   2. 从 `pkHome`（/leo-game-pk/android/math/pk/home）取 **PK 体系**的 pointId
 *      （之前的 2005 是竞速 pointId，235001 是练习 keypoint → 都不是 PK 的）
 *   3. 用正确 pointId 再试一次
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const leo = require(path.join(ROOT, 'src', 'leo'));
const nativeLib = require(path.join(ROOT, 'src', 'native.js'));
const { request } = require(path.join(ROOT, 'src', 'http'));

const ACC_ID = Number(process.argv[2] || 15);
const HOST = 'https://xyks.yuanfudao.com';

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function qsOf(o) {
  return Object.keys(o).filter((k) => o[k] != null)
    .map((k) => k + '=' + encodeURIComponent(o[k])).join('&');
}

const COMMON = {
  _productId: '611',
  platform: 'android37',
  version: '3.141.1',
  vendor: 'UC',
  deviceCategory: 'phone',
  av: '5',
  webviewVersion: '150',
  whRatio: '2.17',
  isBackground: '1',
};

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号 ' + ACC_ID); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 id=' + acc.id + '  yfd_u=' + acc.yfd_u);

  // ---------- ① PK 主页，找 pointId ----------
  line('');
  line('='.repeat(90));
  line('① GET /leo-game-pk/android/math/pk/home  （找 PK 体系的 pointId）');
  line('='.repeat(90));
  let pkPointId = null;
  try {
    const p = '/leo-game-pk/android/math/pk/home';
    const q = Object.assign({}, COMMON, { grade: '2' });
    const sign = nativeLib.calcSign(p, { variant: 'exercise' });
    const url = HOST + p + '?' + qsOf(q) + '&sign=' + sign;
    const r = await request({ url, method: 'GET', jar, headers: leo.riskHeaders(), timeoutMs: 20000 });
    line('  HTTP ' + r.status);
    const body = String(r.text || '');
    line('  body: ' + body.slice(0, 700).replace(/\s+/g, ' '));
    // 挖 pointId
    const ids = body.match(/"pointId"\s*:\s*(\d+)/g) || [];
    const uniq = Array.from(new Set(ids.map((x) => x.replace(/\D/g, ''))));
    if (uniq.length) {
      pkPointId = uniq[0];
      line('  → 从 pk/home 挖到 pointId: ' + uniq.join(', '));
    }
  } catch (e) {
    line('  异常: ' + e.message);
  }

  await sleep(3000);

  // ---------- ② 干净单发：exercise + 3.141.1 ----------
  line('');
  line('='.repeat(90));
  line('② 单发 POST pk/match/v2（exercise + 3.141.1）');
  line('='.repeat(90));
  const p2 = '/leo-game-pk/android/math/pk/match/v2';
  try {
    const q = Object.assign({}, COMMON, { pointId: String(pkPointId || 2005), triggerPeakMatch: '0' });
    const sign = nativeLib.calcSign(p2, { variant: 'exercise' });
    const url = HOST + p2 + '?' + qsOf(q) + '&sign=' + sign;
    const r = await request({
      url, method: 'POST', jar, body: '',
      headers: Object.assign({}, leo.riskHeaders(), { 'Content-Type': 'application/json' }),
      timeoutMs: 20000,
    });
    const blk = (r.headers && (r.headers['x-block-by'] || r.headers['X-Block-By'])) || '-';
    line('  pointId=' + (pkPointId || 2005) + '  sign=' + sign);
    line('  → HTTP ' + r.status + '   x-block-by=' + blk);
    line('  body: ' + String(r.text || '').slice(0, 240).replace(/\s+/g, ' '));
    if (r.status !== 417) {
      line('  ✅ sign 已通过（非 417）—— 说明 exercise + 3.141.1 是正确的配对。');
    } else {
      line('  ❌ 仍 417。');
    }
  } catch (e) {
    line('  异常: ' + e.message);
  }

  await sleep(3000);

  // ---------- ③ 对照：pk + 3.143.1 ----------
  line('');
  line('='.repeat(90));
  line('③ 对照 POST pk/match/v2（pk + 3.143.1）');
  line('='.repeat(90));
  try {
    const q = Object.assign({}, COMMON, { version: '3.143.1', pointId: String(pkPointId || 2005), triggerPeakMatch: '0' });
    const sign = nativeLib.calcSign(p2, { variant: 'pk' });
    const url = HOST + p2 + '?' + qsOf(q) + '&sign=' + sign;
    const r = await request({
      url, method: 'POST', jar, body: '',
      headers: Object.assign({}, leo.riskHeaders(), { 'Content-Type': 'application/json' }),
      timeoutMs: 20000,
    });
    const blk = (r.headers && (r.headers['x-block-by'] || r.headers['X-Block-By'])) || '-';
    line('  → HTTP ' + r.status + '   x-block-by=' + blk);
    line('  body: ' + String(r.text || '').slice(0, 240).replace(/\s+/g, ' '));
    if (r.status !== 417) line('  ✅ sign 已通过。');
  } catch (e) {
    line('  异常: ' + e.message);
  }

  line('');
  line('='.repeat(90));
  line('结论');
  line('='.repeat(90));
  line('  若 ② 与 ③ 都非 417 → 证实「version 与签名资产绑定」，417 已解。');
  line('  剩下的 400 是业务参数问题（pointId / 频控），与签名无关。');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });