#!/usr/bin/env node
'use strict';
/**
 * 定案实验：`x-shepherd-did` 是不是 401 的开关？
 *
 * ## 推理链
 *
 *   1. 同一套 cookie，pk-node 打 switch / batchGet **全 200**（六种 body 组合全 200）
 *   2. App 打同两个端点 **恒 401**（真机脱敏日志：cookie 12 条全在、版本/sign/YFD_U 全对）
 *   3. ⇒ 差异必在**请求头**
 *
 * ## 已发现的具体差异
 *
 * pk-node `mainDomainHeaders()`：
 *
 *     if (config.shepherdDid) h['x-shepherd-did'] = config.shepherdDid;
 *
 *   → 默认 `PK_SHEPHERD_DID` 为空 ⇒ **不发**这个头。
 *
 * App `HeaderInterceptor`（主域分支）**无条件发**：
 *
 *     builder.header("x-shepherd-did", ShepherdId.did())
 *     // 默认值 = 真机抓包那台设备的 did：
 *     //   "DUtA-DmaWBaa-xgaLMMFCl5fjJG__ajuzNf3"
 *
 * ## 为什么这个头会致病
 *
 * `did` 是**设备指纹**，服务端把它与 cookie 里的设备链 `ks_*` 做**一致性校验**。
 * 本 App 的 cookie 用的是「导入的设备链」（`ks_deviceid=350266477`），
 * 而硬编码的 did 来自**另一台设备**（真机抓包那台）→ 两者对不上 → 401。
 *
 * 这也能解释为什么 `context` / `profile` 仍 200：那两个端点**不做设备一致性校验**。
 *
 * ## 本实验
 *
 *   ① 不发 did（基线，应 200）
 *   ② 发 DUtA-...（App 的硬编码值，预期 401）
 *   ③ 发空串
 *   ④ 发随机值
 *   ⑤ 再回到不发（验证可复现）
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

const BATCH = '/leo-profile/android/user-infos/batchGet';
const SWITCH = '/leo-gateway/android/accounts/switch';

/** App 硬编码的 did（HeaderInterceptor.ShepherdId.DEFAULT_DID）。 */
const APP_DID = 'DUtA-DmaWBaa-xgaLMMFCl5fjJG__ajuzNf3';

async function hit(label, o) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(raw)));
  const u = new URL('https://xyks.yuanfudao.com' + o.path);
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
  u.searchParams.set('sign', native.calcSign(o.path, { version: '3.141.1' }));

  const headers = leo.mainDomainHeaders();
  if (o.did !== undefined) {
    if (o.did === null) delete headers['x-shepherd-did'];
    else headers['x-shepherd-did'] = o.did;
  }
  if (o.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';

  try {
    const r = await request({
      url: u.toString(), method: o.method || 'GET', jar,
      body: o.body, headers,
    });
    const tag = r.status === 200 ? '✅ 200' : '❌ ' + r.status;
    line('  ' + label.padEnd(46) + tag +
      (r.status !== 200 ? '  ' + String(r.text).slice(0, 56).replace(/\s+/g, ' ') : ''));
    return r.status;
  } catch (e) {
    line('  ' + label.padEnd(46) + '异常 ' + ((e && e.message) || e));
    return -1;
  }
}

(async () => {
  hr('batchGet');
  await hit('① 不发 did（pk-node 基线）', { path: BATCH, did: null });
  await new Promise((r) => setTimeout(r, 1300));
  await hit('② 发 App 硬编码 did ★嫌疑', { path: BATCH, did: APP_DID });
  await new Promise((r) => setTimeout(r, 1300));
  await hit('③ 发空串 did', { path: BATCH, did: '' });
  await new Promise((r) => setTimeout(r, 1300));
  await hit('④ 发随机 did', { path: BATCH, did: 'ZZZZ-ZZZZZZZZ-ZZZZZZZZZZZZZZZZZZZZZ' });
  await new Promise((r) => setTimeout(r, 1300));
  await hit('⑤ 再不发（复现性验证）', { path: BATCH, did: null });

  hr('switch（POST）');
  await hit('① 不发 did', { path: SWITCH, method: 'POST', body: 'targetUserId=1157242893', did: null });
  await new Promise((r) => setTimeout(r, 1300));
  await hit('② 发 App 硬编码 did ★嫌疑', {
    path: SWITCH, method: 'POST', body: 'targetUserId=1157242893', did: APP_DID,
  });

  hr('判定');
  line('  · 若② 401 而① 200 ⇒ 根因 = App 硬编码的 x-shepherd-did 与设备链不匹配');
  line('    修法：不要发与设备链不匹配的 did（要么不发，要么与链同源）');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });