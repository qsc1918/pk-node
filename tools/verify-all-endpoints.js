#!/usr/bin/env node
'use strict';
/**
 * 逐端点验证：哪些主域端点「带正确 sign 也不放行」。
 *
 * ## 真机现状（修复 cookie 后）
 *
 * ```
 * /profile/android/user-info            → 200   （账号域，不要 sign）
 * /leo-profile/api/user-infos/context   → 200   （主域，带 sign）
 * /leo-profile/android/user-infos/batchGet → 417 （主域，带 sign）
 * ```
 *
 * pk-node 侧同 cookie、同 sign 口径打 batchGet → **200**（已证）。
 *
 * ⇒ 说明 App 发出去的 sign **与服务端期望的不一致**。
 *
 * ## 本实验
 *
 * 把 App 会用到的每个主域端点，都用 exercise 资产算 sign 打一遍，
 * 看哪些 200、哪些 417 —— 得到「哪些端点 App 能通」的真实清单。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const native = require(path.join(ROOT, 'src', 'native'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const raw = JSON.parse(fs.readFileSync('/tmp/dev_cookies_now.json', 'utf8'));

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(90)); line(t); line('='.repeat(90)); }

const ENDPOINTS = [
  ['/leo-profile/api/user-infos/context', { _productId: '241' }, 'GET'],
  ['/leo-profile/android/user-infos/batchGet', { _productId: '611' }, 'GET'],
  ['/leo-math/android/exams/exercises/type/0', { grade: '13', semester: '1', book: '1' }, 'GET'],
  ['/leo-star/android/exercise/homepage', {}, 'GET'],
  ['/leo-star/android/exercise/rank/pre-fetch', {}, 'GET'],
  ['/leo-gateway/android/accounts/switch', {}, 'POST'],
];

(async () => {
  hr('逐端点：带 exercise 资产的 sign');

  for (const [p, extra, method] of ENDPOINTS) {
    const jar = new CookieJar(JSON.parse(JSON.stringify(raw)));
    const u = new URL('https://xyks.yuanfudao.com' + p);
    u.searchParams.set('_productId', extra._productId || '611');
    u.searchParams.set('platform', 'android37');
    u.searchParams.set('version', '3.141.1');
    u.searchParams.set('vendor', 'UC');
    u.searchParams.set('av', '5');
    u.searchParams.set('deviceCategory', 'phone');
    u.searchParams.set('webviewVersion', '150');
    u.searchParams.set('whRatio', '2.17');
    u.searchParams.set('isBackground', '0');
    u.searchParams.set('YFD_U', '511467407');
    for (const [k, v] of Object.entries(extra)) {
      if (k !== '_productId') u.searchParams.set(k, v);
    }
    u.searchParams.set('sign', native.calcSign(p, { version: '3.141.1' }));

    try {
      const r = await request({
        url: u.toString(), method, jar, headers: leo.mainDomainHeaders(),
        body: method === 'POST' ? 'targetUserId=1157242893' : undefined,
      });
      line('  ' + p.padEnd(46) +
        (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
        (r.headers['x-block-by'] ? '  block-by=' + r.headers['x-block-by'] : ''));
    } catch (e) {
      line('  ' + p.padEnd(46) + '异常 ' + e.message);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  hr('结论');
  line('  · 若 batchGet 在服务端侧 200 而 App 417 ⇒ App 的 sign 值不对');
  line('  · 需要让 App dump 它算出的 sign 与服务端期望比对');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });