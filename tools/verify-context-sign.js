#!/usr/bin/env node
'use strict';
/**
 * 验证「App 的 sign 是否随分钟漂移」—— 找 context 200 / batchGet 417 的解释。
 *
 * ## 现象
 *
 *   09:12:20 同一秒内：
 *     context  → 200（sign 被接受）
 *     batchGet → 417（sign 被拒）
 *
 * 同一份 so、同一分钟、同一次 App 会话 —— 若 T 正确，两个都该过。
 *
 * ## 假设
 *
 * `context` 走的是 **`@CheckNothing` + 不需要 sign 校验**的路径
 * （它是「无设备链也能拿到子账号 ID」的通道），服务端**根本不校验它的 sign**。
 * 而 `batchGet` **要校验**。
 *
 * ⇒ 所以「context 200」不能证明 App 的 sign 是对的。
 *
 * ## 本实验
 *
 * 对 context 分别用「正确 sign / 错 sign / 无 sign」，看它是否**恒 200**。
 * 若恒 200 ⇒ 上面假设成立 ⇒ App 的 sign 仍然是坏的，要单独修。
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

const CTX = '/leo-profile/api/user-infos/context';

async function hit(label, signValue) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(raw)));
  const u = new URL('https://xyks.yuanfudao.com' + CTX);
  for (const [k, v] of [
    ['_productId', '241'], ['platform', 'android37'], ['version', '3.141.1'],
    ['vendor', 'UC'], ['av', '5'], ['deviceCategory', 'phone'],
    ['webviewVersion', '150'], ['whRatio', '2.17'], ['isBackground', '0'],
  ]) u.searchParams.set(k, v);
  u.searchParams.set('YFD_U', '511467407');
  if (signValue !== null) u.searchParams.set('sign', signValue);

  const r = await request({
    url: u.toString(), method: 'GET', jar, headers: leo.mainDomainHeaders(),
  });
  line('  ' + label.padEnd(36) +
    (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
    (r.headers['x-block-by'] ? '  block-by=' + r.headers['x-block-by'] : ''));
  return r.status;
}

(async () => {
  hr('context 是否校验 sign？');
  await hit('正确 sign（exercise）', native.calcSign(CTX, { version: '3.141.1' }));
  await new Promise((r) => setTimeout(r, 1200));
  await hit('sign = 全 0', '0'.repeat(32));
  await new Promise((r) => setTimeout(r, 1200));
  await hit('不带 sign', null);
  await new Promise((r) => setTimeout(r, 1200));
  await hit('sign = pk 资产（错配）', native.calcSign(CTX, { variant: 'pk' }));

  hr('对照：batchGet 同样三档');
  {
    const B = '/leo-profile/android/user-infos/batchGet';
    for (const [label, sv] of [
      ['正确 sign', native.calcSign(B, { version: '3.141.1' })],
      ['全 0', '0'.repeat(32)],
      ['不带 sign', null],
    ]) {
      const jar = new CookieJar(JSON.parse(JSON.stringify(raw)));
      const u = new URL('https://xyks.yuanfudao.com' + B);
      for (const [k, v] of [
        ['_productId', '611'], ['platform', 'android37'], ['version', '3.141.1'],
        ['vendor', 'UC'], ['av', '5'], ['deviceCategory', 'phone'],
        ['webviewVersion', '150'], ['whRatio', '2.17'], ['isBackground', '0'],
      ]) u.searchParams.set(k, v);
      u.searchParams.set('YFD_U', '511467407');
      if (sv !== null) u.searchParams.set('sign', sv);
      const r = await request({
        url: u.toString(), method: 'GET', jar, headers: leo.mainDomainHeaders(),
      });
      line('  ' + ('batchGet ' + label).padEnd(36) +
        (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
        (r.headers['x-block-by'] ? '  block-by=' + r.headers['x-block-by'] : ''));
      await new Promise((r2) => setTimeout(r2, 1200));
    }
  }

  hr('判定');
  line('  · context 若「错 sign / 无 sign」都 200 ⇒ 它不校验 sign，');
  line('    不能拿它当「App 的 sign 是对的」的证据');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });