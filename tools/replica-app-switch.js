#!/usr/bin/env node
'use strict';
/**
 * 最终对照：模拟 **App 脱敏日志里显示的那一份请求**，逐字节复刻。
 *
 * ## 真机日志显示的完整请求（08:56:08）
 *
 * ```
 * POST /leo-gateway/android/accounts/switch
 *   ?_productId=611&platform=android37&version=3.141.1&vendor=UC&av=5
 *   &deviceCategory=phone&webviewVersion=150&whRatio=2.17
 *   &isBackground=0&sign=250c64…&YFD_U=511467407   → 401
 *
 * cookie=ks_persistent(len=128), persistent(len=108), userid(len=9,511467…),
 *        ks_r(len=64), ks_deviceid(len=9,350266…), ks_u(len=64),
 *        g_loc(len=24), sid(len=18), sess(len=64), g_sess(len=152),
 *        __sub_user_infos__(len=88), ks_sess(len=64)
 * ua=Leo/3.141.1 (Redmi25053RT47C; Android 37; Scale/3.25)
 * ```
 *
 * ## 逐字节复刻
 *
 * 注意几个**顺序**细节（服务端可能按顺序解析）：
 *   · URL 参数顺序 —— App 是 `_productId` 最前，然后 platform/version/vendor/av/
 *     deviceCategory/webviewVersion/whRatio/isBackground，sign 在 YFD_U **之前**
 *   · cookie 顺序 —— App 的是 ks_persistent, persistent, userid, ks_r,
 *     ks_deviceid, ks_u, g_loc, sid, sess, g_sess, __sub_user_infos__, ks_sess
 *
 * `sign` 是按 path 算的，与 query 无关，所以 App 与 pk-node 的 sign 必然**相同**
 * （同一个分钟内）。若不同 ⇒ 说明 App 的 so 算错了。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const native = require(path.join(ROOT, 'src', 'native'));

const raw = JSON.parse(fs.readFileSync('/tmp/dev_cookies_now.json', 'utf8'));

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(90)); line(t); line('='.repeat(90)); }

const SWITCH = '/leo-gateway/android/accounts/switch';

/** App 脱敏日志里的 cookie **顺序**。 */
const APP_COOKIE_ORDER = [
  'ks_persistent', 'persistent', 'userid', 'ks_r', 'ks_deviceid', 'ks_u',
  'g_loc', 'sid', 'sess', 'g_sess', '__sub_user_infos__', 'ks_sess',
];

function cookieHeaderInAppOrder() {
  const byName = {};
  for (const c of raw) byName[c.name] = c.value;
  return APP_COOKIE_ORDER
    .filter((n) => byName[n] != null)
    .map((n) => n + '=' + byName[n])
    .join('; ');
}

(async () => {
  hr('① 逐字节复刻 App 的 switch 请求');

  const u = new URL('https://xyks.yuanfudao.com' + SWITCH);
  // App 的参数顺序（CommonQueryInterceptor 重排后的结果）
  u.searchParams.set('_productId', '611');
  u.searchParams.set('platform', 'android37');
  u.searchParams.set('version', '3.141.1');
  u.searchParams.set('vendor', 'UC');
  u.searchParams.set('av', '5');
  u.searchParams.set('deviceCategory', 'phone');
  u.searchParams.set('webviewVersion', '150');
  u.searchParams.set('whRatio', '2.17');
  u.searchParams.set('isBackground', '0');
  const sign = native.calcSign(SWITCH, { version: '3.141.1' });
  u.searchParams.set('sign', sign);
  u.searchParams.set('YFD_U', '511467407');

  const headers = {
    'User-Agent': 'Leo/3.141.1 (Redmi25053RT47C; Android 37; Scale/3.25)',
    Accept: 'application/json',
    'X-App-Version': '3.141.17',
    'X-App-Version-Code': '31427',
    'X-Channel': 'official',
    'X-XYKS-REQ-TIMESTAMP': String(Date.now()),
    'X-XYKS-REQ-NETWORK-ENV': 'mobile',
    'x-shepherd-did': 'DUtA-DmaWBaa-xgaLMMFCl5fjJG__ajuzNf3',
    'x-shepherd-sessionid': '0',
    'leo-client-trace-id': 'abcdef0123456789abcd',
    'default-namespace-sw8': 'MQ==-YWJjZGVmMDEyMzQ1Njc4OWFiY2Q=-MA==-0-X19PX1JfVF9f-UF9J-UF9F-SV9Q',
    Cookie: cookieHeaderInAppOrder(),
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  line('  URL: ' + u.toString());
  line('  Cookie 顺序: ' + APP_COOKIE_ORDER.join(', '));
  line();

  try {
    const r = await request({
      url: u.toString(), method: 'POST', headers,
      body: 'targetUserId=1157242893',
    });
    line('  ⇒ ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status));
    line('  body: ' + String(r.text).slice(0, 200).replace(/\s+/g, ' '));
    if (r.headers['x-block-by']) line('  x-block-by: ' + r.headers['x-block-by']);
  } catch (e) {
    line('  异常: ' + ((e && e.message) || e));
  }

  hr('② 同样复刻 batchGet');
  {
    const BATCH = '/leo-profile/android/user-infos/batchGet';
    const u2 = new URL('https://xyks.yuanfudao.com' + BATCH);
    for (const [k, v] of [
      ['_productId', '611'], ['platform', 'android37'], ['version', '3.141.1'],
      ['vendor', 'UC'], ['av', '5'], ['deviceCategory', 'phone'],
      ['webviewVersion', '150'], ['whRatio', '2.17'], ['isBackground', '0'],
    ]) u2.searchParams.set(k, v);
    u2.searchParams.set('sign', native.calcSign(BATCH, { version: '3.141.1' }));
    u2.searchParams.set('YFD_U', '511467407');

    const r2 = await request({
      url: u2.toString(), method: 'GET', headers: Object.assign({}, headers, {
        'Content-Type': 'application/json',
      }),
    });
    line('  ⇒ ' + (r2.status === 200 ? '✅ 200' : '❌ ' + r2.status));
    line('  body: ' + String(r2.text).slice(0, 160).replace(/\s+/g, ' '));
  }

  hr('说明');
  line('  sign = ' + sign + '（按 path 算，App 应与此相同）');
  line('  若① 仍 200 ⇒ App 的 401 不是这些可见因素造成的，');
  line('  需要对比 App 发出的**原始字节**（下一步：抓包或让 App dump 完整 header）');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });