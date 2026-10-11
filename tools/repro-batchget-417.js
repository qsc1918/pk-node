#!/usr/bin/env node
'use strict';
/**
 * 复现 batchGet 的 417（sign 层）—— 现在 cookie 已修好，暴露出的下一层问题。
 *
 * ## 真机日志（09:12:20，修复后）
 *
 * ```
 * GET /leo-profile/api/user-infos/context
 *     ?_productId=241&platform=android37&version=3.141.1&...&sign=87242b… → 200
 * GET /leo-profile/android/user-infos/batchGet
 *     ?_productId=611&platform=android37&version=3.141.1&...&sign=d1f524… → 417
 * ```
 *
 * 两者 query 几乎一致（除 `_productId`），却一个 200 一个 417。
 *
 * ## 关键区别：sign 的值
 *
 *   context  : sign=87242b…
 *   batchGet : sign=d1f524…
 *
 * sign 是 `chainMd5(path, T)` —— **只与 path 有关**，不同 path 的 sign 本就不同。
 * 所以「值不同」正常。真正的问题可能是 **App 算出来的 sign 与服务端期望的不一致**。
 *
 * ## 本实验
 *
 * 用真机 cookie，按 App 的**完整参数**打 batchGet：
 *   ① sign 用 exercise 资产（当前正确口径）
 *   ② sign 用 pk 资产（错配）
 *   ③ 不带 sign
 * 看哪个 417、哪个 200。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const native = require(path.join(ROOT, 'src', 'native'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const raw = JSON.parse(fs.readFileSync('/tmp/dev_cookies_now.json', 'utf8'));

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

const BATCH = '/leo-profile/android/user-infos/batchGet';

async function hit(label, signKind) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(raw)));
  const u = new URL('https://xyks.yuanfudao.com' + BATCH);
  for (const [k, v] of [
    ['_productId', '611'], ['platform', 'android37'], ['version', '3.141.1'],
    ['vendor', 'UC'], ['av', '5'], ['deviceCategory', 'phone'],
    ['webviewVersion', '150'], ['whRatio', '2.17'], ['isBackground', '0'],
  ]) u.searchParams.set(k, v);
  u.searchParams.set('YFD_U', '511467407');
  if (signKind === 'exercise') {
    u.searchParams.set('sign', native.calcSign(BATCH, { version: '3.141.1' }));
  } else if (signKind === 'pk') {
    u.searchParams.set('sign', native.calcSign(BATCH, { variant: 'pk' }));
  } else if (signKind === 'zero') {
    u.searchParams.set('sign', '0'.repeat(32));
  }

  const r = await request({
    url: u.toString(), method: 'GET', jar, headers: leo.mainDomainHeaders(),
  });
  line('  ' + label.padEnd(34) +
    (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
    (r.headers['x-block-by'] ? '  block-by=' + r.headers['x-block-by'] : '') +
    (r.status !== 200 ? '  ' + String(r.text).slice(0, 50).replace(/\s+/g, ' ') : ''));
  return r.status;
}

(async () => {
  hr('batchGet：sign 变体对照');
  await hit('sign = exercise 资产（当前口径）', 'exercise');
  await new Promise((r) => setTimeout(r, 1200));
  await hit('sign = pk 资产（错配）', 'pk');
  await new Promise((r) => setTimeout(r, 1200));
  await hit('sign = 全 0', 'zero');
  await new Promise((r) => setTimeout(r, 1200));
  await hit('不带 sign', 'none');

  hr('App 当时用的 sign（截断前 6 位）');
  line('  context  : 87242b…');
  line('  batchGet : d1f524…');
  line();
  line('  本次复算 exercise = ' +
    native.calcSign(BATCH, { version: '3.141.1' }));

  hr('说明');
  line('  sign 与分钟有关，无法直接比对历史值；');
  line('  但若「exercise 资产 → 200」，说明 App 只要用对资产就能通。');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });