#!/usr/bin/env node
'use strict';
/**
 * 复现 App 的 switch 401 —— 唯一剩下的变量是 body。
 *
 * ## 现已排除的变量（全部已证一致）
 *
 *   · Cookie 头：12 条全在、ks_* 长度全对（真机脱敏日志铁证）
 *   · query：version=3.141.1 / sign / YFD_U=511467407 / _productId=611 …
 *   · UA / 头：Leo/3.141.1 …
 *   · 同一套 cookie 服务端侧打 batchGet / switch **都是 200**
 *
 * ## 剩下的差别
 *
 * App 的 `switchAccount` 是 **`@FormUrlEncoded` + `@Field("targetUserId")`**，
 * 即 body 为 `targetUserId=<数字>`，Content-Type 由 Retrofit 生成。
 *
 * pk-node 是 `URLSearchParams({targetUserId}).toString()` +
 * `Content-Type: application/x-www-form-urlencoded; charset=utf-8`。
 *
 * 二者**看着一样，但可能差在**：
 *   1. Retrofit 的 `@FormUrlEncoded` 不带 `charset=utf-8`；
 *   2. Retrofit 的字段名/编码方式（数字 vs 字符串）；
 *   3. **目标 ID 不同** —— App 点的是某个具体子账号。
 *
 * 本脚本把这几条逐一试，找出 401 的确切条件。
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

const SWITCH = '/leo-gateway/android/accounts/switch';

async function trySwitch(label, opts) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(raw)));
  const u = new URL('https://xyks.yuanfudao.com' + SWITCH);
  u.searchParams.set('_productId', '611');
  u.searchParams.set('platform', 'android37');
  u.searchParams.set('version', '3.141.1');
  u.searchParams.set('vendor', 'UC');
  u.searchParams.set('av', '5');
  u.searchParams.set('deviceCategory', 'phone');
  u.searchParams.set('webviewVersion', '150');
  u.searchParams.set('whRatio', '2.17');
  u.searchParams.set('isBackground', '0');
  if (opts.yfdU !== false) u.searchParams.set('YFD_U', opts.yfdU || '511467407');
  u.searchParams.set('sign', native.calcSign(SWITCH, { version: '3.141.1' }));

  const headers = leo.mainDomainHeaders();
  if (opts.ct) headers['Content-Type'] = opts.ct;

  try {
    const r = await request({
      url: u.toString(), method: 'POST', jar,
      body: opts.body, headers,
    });
    const tag = r.status === 200 ? '✅ 200' : '❌ ' + r.status;
    line('  ' + label.padEnd(50) + tag +
      (r.status !== 200 ? '  ' + String(r.text).slice(0, 60).replace(/\s+/g, ' ') : ''));
    return r;
  } catch (e) {
    line('  ' + label.padEnd(50) + '异常 ' + ((e && e.message) || e));
    return null;
  }
}

(async () => {
  hr('switch —— body/头/目标的组合对照');

  const T = '1157242893';

  await trySwitch('默认（无 charset）', {
    body: 'targetUserId=' + T,
    ct: 'application/x-www-form-urlencoded',
  });
  await new Promise((r) => setTimeout(r, 1500));

  await trySwitch('带 charset=utf-8', {
    body: 'targetUserId=' + T,
    ct: 'application/x-www-form-urlencoded; charset=utf-8',
  });
  await new Promise((r) => setTimeout(r, 1500));

  await trySwitch('带 YFD_U（同 App）', {
    body: 'targetUserId=' + T,
    ct: 'application/x-www-form-urlencoded; charset=utf-8',
    yfdU: '511467407',
  });
  await new Promise((r) => setTimeout(r, 1500));

  await trySwitch('不带 YFD_U', {
    body: 'targetUserId=' + T,
    ct: 'application/x-www-form-urlencoded; charset=utf-8',
    yfdU: false,
  });
  await new Promise((r) => setTimeout(r, 1500));

  await trySwitch('切到 1066052990', {
    body: 'targetUserId=1066052990',
    ct: 'application/x-www-form-urlencoded; charset=utf-8',
  });
  await new Promise((r) => setTimeout(r, 1500));

  await trySwitch('切到当前自身 511467407', {
    body: 'targetUserId=511467407',
    ct: 'application/x-www-form-urlencoded; charset=utf-8',
  });

  hr('参考：pk-node 官方封装');
  {
    const jar = new CookieJar(JSON.parse(JSON.stringify(raw)));
    const r = await leo.switchSubAccount(jar, Number(T));
    line('  leo.switchSubAccount(1157242893)'.padEnd(50) +
      (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
      '  ' + String(r.text).slice(0, 60).replace(/\s+/g, ' '));
  }

  hr('判定');
  line('  · 若某个组合 401 而其它 200 ⇒ 找到根因，改 App 对应处即可');
  line('  · 若全 200 ⇒ App 的 401 来自「body 内容」与上面不同的某个目标 ID');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });