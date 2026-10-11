#!/usr/bin/env node
'use strict';
/**
 * 验证「sign 正确性」与状态码的关系，并复算 App 当时的 sign。
 *
 * ## 动机
 *
 * App 日志（08:56:06）：
 *
 *     ...&sign=250c64…&YFD_U=511467407 → 401
 *
 * 我复刻同样请求（当前分钟）→ 200。
 * sign 是**按分钟**变化的（T 由「分钟」派生），所以需要**复算当时那一分钟**的值
 * 才能判断 App 的 sign 是否正确。
 *
 * ## 本实验
 *
 *   ① batchGet：sign 正确 / 改成错的 / 不带 sign —— 看状态码分别是多少
 *   ② 复算 08:56 那一分钟、switch 路径的正确 sign，与 App 的 `250c64…` 比对
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const native = require(path.join(ROOT, 'src', 'native'));
const config = require(path.join(ROOT, 'src', 'config'));

const raw = JSON.parse(fs.readFileSync('/tmp/dev_cookies_now.json', 'utf8'));

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(90)); line(t); line('='.repeat(90)); }

const BATCH = '/leo-profile/android/user-infos/batchGet';
const SWITCH = '/leo-gateway/android/accounts/switch';

/** 复算指定「秒级时间戳」所属分钟的 sign。 */
function signAt(seconds, urlPath, variant) {
  const minute = Math.floor(seconds / 60);
  const pk = variant === 'pk';
  // native.js 内部：T = calcT(minute*60, variant)；sign = chainMd5(path, T)
  const T = native.calcT(minute * 60, pk ? 'pk' : 'exercise');
  return native.chainMd5(urlPath, T);
}

async function probe(label, signValue) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(raw)));
  const u = new URL('https://xyks.yuanfudao.com' + BATCH);
  u.searchParams.set('_productId', '611');
  u.searchParams.set('platform', 'android37');
  u.searchParams.set('version', '3.141.1');
  u.searchParams.set('vendor', 'UC');
  u.searchParams.set('av', '5');
  u.searchParams.set('deviceCategory', 'phone');
  u.searchParams.set('webviewVersion', '150');
  u.searchParams.set('whRatio', '2.17');
  u.searchParams.set('isBackground', '0');
  u.searchParams.set('YFD_U', '511467407');
  if (signValue !== null) u.searchParams.set('sign', signValue);

  const r = await request({
    url: u.toString(), method: 'GET', jar, headers: {
      'User-Agent': 'Leo/3.141.1 (Redmi25053RT47C; Android 37; Scale/3.25)',
      Accept: 'application/json',
      'X-App-Version': '3.141.17',
      'X-Channel': 'official',
      'X-XYKS-REQ-TIMESTAMP': String(Date.now()),
      'X-XYKS-REQ-NETWORK-ENV': 'mobile',
      'x-shepherd-sessionid': '0',
      'leo-client-trace-id': 'abcdef0123456789abcd',
      'default-namespace-sw8': 'MQ==-YWJjZGVmMDEyMzQ1Njc4OWFiY2Q=-MA==-0-X19PX1JfVF9f-UF9J-UF9F-SV9Q',
    },
  });
  const tag = r.status === 200 ? '✅ 200' : '❌ ' + r.status;
  line('  ' + label.padEnd(40) + tag +
    (r.headers['x-block-by'] ? '  block-by=' + r.headers['x-block-by'] : '') +
    (r.status !== 200 ? '  ' + String(r.text).slice(0, 50).replace(/\s+/g, ' ') : ''));
}

(async () => {
  hr('① sign 正确性 → 状态码');

  await probe('正确 sign（当前分钟）', native.calcSign(BATCH, { version: '3.141.1' }));
  await new Promise((r) => setTimeout(r, 1200));

  await probe('错误 sign（全 0）', '00000000000000000000000000000000');
  await new Promise((r) => setTimeout(r, 1200));

  await probe('错误 sign（改一位）',
    native.calcSign(BATCH, { version: '3.141.1' }).slice(0, 31) + 'f');
  await new Promise((r) => setTimeout(r, 1200));

  await probe('不带 sign', null);
  await new Promise((r) => setTimeout(r, 1200));

  // 上一分钟的 sign（过期）
  await probe('上一分钟的 sign（过期）',
    signAt(Math.floor(Date.now() / 1000) - 90, BATCH, 'exercise'));

  hr('② 复算 App 当时那一分钟的 sign');

  // App 的 switch：08:56:06 CST = 00:56:06 UTC
  // 1791680166547 ms（来自日志时间戳）
  const appTs = 1791680166;
  const exSign = signAt(appTs, SWITCH, 'exercise');
  const pkSign = signAt(appTs, SWITCH, 'pk');

  line('  App 日志里的 sign      = 250c64…（被截断，只存了前 6 位）');
  line('  复算 exercise 资产      = ' + exSign);
  line('  复算 pk 资产            = ' + pkSign);
  line();
  line('  exercise 前6位 = ' + exSign.slice(0, 6) +
    (exSign.startsWith('250c64') ? '  ★★ 与 App 一致' : '  （不一致）'));
  line('  pk       前6位 = ' + pkSign.slice(0, 6) +
    (pkSign.startsWith('250c64') ? '  ★★ 与 App 一致' : '  （不一致）'));

  hr('③ 同时复算 batchGet 那一分钟');
  line('  fetch 前端无 batchGet 日志（未打印 query）');

  hr('判定');
  line('  · 若「错误 sign」也返回 401 ⇒ App 的 401 可能来自 sign 内容错误');
  line('  · 若②里 exercise 命中 ⇒ App 的 sign 是对的，401 另有原因');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });