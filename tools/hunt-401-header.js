#!/usr/bin/env node
'use strict';
/**
 * 拿 401 的**完整响应头** —— 这是最后一块拼图。
 *
 * ## 已确认
 *
 *   · 正确 sign / 错一位的 sign / 不带的差异 → 417（solar-encoder），**不是 401**
 *   · 服务端侧用真机 cookie 打 switch/batchGet → 200（穷尽 cookie 顺序、did、
 *     YFD_U、body 组合、header 组合）
 *   · App 侧 → 401 `{"status":401,"message":"unauthorized"}`
 *
 * ⇒ 401 与 417 是**两层**。App 过了 encoder 那关（否则会 417），
 *    倒在了 **leo-auth**。
 *
 * ## 本脚本
 *
 * 想办法**复现出 401**，并打印其完整响应头（找 `x-block-by` / `www-authenticate`
 * 之类的判据）。尝试方向：
 *   ① 用**过期的** ks_*（模拟设备链真失效）
 *   ② 用**不存在的** ks_deviceid
 *   ③ ks_* 与 userid 不匹配（userid 是 A，ks 链属于 B）
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const native = require(path.join(ROOT, 'src', 'native'));

const raw = JSON.parse(fs.readFileSync('/tmp/dev_cookies_now.json', 'utf8'));

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(90)); line(t); line('='.repeat(90)); }

const BATCH = '/leo-profile/android/user-infos/batchGet';

/** 造一份 cookie 列表（在真机基础上做改造）。 */
function mutated(mut) {
  const out = JSON.parse(JSON.stringify(raw));
  for (const [name, value] of Object.entries(mut)) {
    const c = out.find((x) => x.name === name);
    if (c) {
      if (value === null) c.value = '';
      else c.value = value;
    }
  }
  return out;
}

async function hit(label, cookies, o = {}) {
  const jar = new CookieJar(cookies);
  const u = new URL('https://xyks.yuanfudao.com' + BATCH);
  for (const [k, v] of [
    ['_productId', '611'], ['platform', 'android37'], ['version', '3.141.1'],
    ['vendor', 'UC'], ['av', '5'], ['deviceCategory', 'phone'],
    ['webviewVersion', '150'], ['whRatio', '2.17'], ['isBackground', '0'],
  ]) u.searchParams.set(k, v);
  u.searchParams.set('sign', native.calcSign(BATCH, { version: '3.141.1' }));
  u.searchParams.set('YFD_U', '511467407');

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
  line('');
  line('  ' + label.padEnd(46) + tag);
  if (r.status !== 200) {
    const interesting = {};
    for (const [k, v] of Object.entries(r.headers)) {
      if (/^(x-|set-cookie|www-authenticate)/i.test(k)) interesting[k] = v;
    }
    line('      headers: ' + JSON.stringify(interesting));
    line('      body: ' + String(r.text).slice(0, 200).replace(/\s+/g, ' '));
  }
  return r.status;
}

(async () => {
  hr('① 基线（真机原样 cookie）');
  await hit('真机 cookie 原样', JSON.parse(JSON.stringify(raw)));
  await new Promise((r) => setTimeout(r, 1300));

  hr('② 破坏 ks_*（找 401 的触发条件）');
  await hit('ks_sess 清空', mutated({ ks_sess: null }));
  await new Promise((r) => setTimeout(r, 1300));
  await hit('ks_deviceid 改成 999999999', mutated({ ks_deviceid: '999999999' }));
  await new Promise((r) => setTimeout(r, 1300));
  await hit('ks_u 改成全 A（64 位）', mutated({ ks_u: 'A'.repeat(64) }));
  await new Promise((r) => setTimeout(r, 1300));

  hr('③ 破坏身份');
  await hit('sid 改掉', mutated({ sid: '1' }));
  await new Promise((r) => setTimeout(r, 1300));
  await hit('userid 改成别的号 1066052990', mutated({ userid: '1066052990' }));
  await new Promise((r) => setTimeout(r, 1300));
  await hit('sess 清空', mutated({ sess: null }));
  await new Promise((r) => setTimeout(r, 1300));

  hr('④ 对照：把 ks_* 全清（模拟「设备链完全丢」）');
  await hit('全部 ks_* 清空', mutated({
    ks_deviceid: null, ks_sess: null, ks_r: null, ks_u: null, ks_persistent: null,
  }));

  hr('判定');
  line('  · 哪个改造得到 401 ⇒ 那就是 App 的实际状态');
  line('  · 同时看 401 的响应头里有没有判据字段');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });