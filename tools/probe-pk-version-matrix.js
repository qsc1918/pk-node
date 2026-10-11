#!/usr/bin/env node
'use strict';
/**
 * PK 出题版本对照：App 用 `3.143.1 + android35 + fenbi`，pk-node 用 `3.141.1 + android37 + UC`。
 *
 * 真机日志显示 App 的 PK 出题是 **400 "No message available"**。
 * 本实验用真机会话 cookie，分别用两套口径打 `/leo-game-pk/.../match/v2`，
 * 看哪一套能过、哪一套 400。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const cookies = JSON.parse(fs.readFileSync('/tmp/dev_cookies.json', 'utf8'));

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

/**
 * @param {string} pathname
 * @param {object} q        查询参数（有序写入）
 * @param {object} headers
 */
async function probe(pathname, q, headers) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v != null) sp.set(k, v);
  }
  const url = 'https://xyks.yuanfudao.com' + pathname + '?' + sp.toString();
  try {
    const r = await request({ url, method: 'GET', jar, headers });
    return { status: r.status, text: r.text };
  } catch (e) {
    return { status: -1, text: String((e && e.message) || e) };
  }
}

/** 真机 PK 口径（App 的 PkProtocol 用的这套）。 */
const APP_Q = {
  _productId: '611',
  platform: 'android35',
  version: '3.143.1',
  vendor: 'fenbi',
  av: '5',
  deviceCategory: 'phone',
  webviewVersion: '110',
  whRatio: '1.78',
};

/** pk-node 口径。 */
const NODE_Q = {
  _productId: '611',
  platform: 'android37',
  version: '3.141.1',
  vendor: 'UC',
  av: '5',
  deviceCategory: 'phone',
  webviewVersion: '150',
  whRatio: '2.17',
};

const MATCH = '/leo-game-pk/android/math/pk/match/v2';

(async () => {
  hr('PK 出题 v2 —— 两套口径对照（pointId=70）');

  const cases = [
    ['App 口径 3.143.1/android35/fenbi', { ...APP_Q, pointId: '70', triggerPeakMatch: '0' }, leo.riskHeaders()],
    ['pk-node 口径 3.141.1/android37/UC', { ...NODE_Q, pointId: '70', triggerPeakMatch: '0' }, leo.mainDomainHeaders()],
    ['仅换 version=3.141.1，其余用 App 口径', { ...APP_Q, version: '3.141.1', pointId: '70', triggerPeakMatch: '0' }, leo.riskHeaders()],
    ['仅换 platform=android37，其余用 App', { ...APP_Q, platform: 'android37', pointId: '70', triggerPeakMatch: '0' }, leo.riskHeaders()],
    ['仅换 vendor=UC，其余用 App', { ...APP_Q, vendor: 'UC', pointId: '70', triggerPeakMatch: '0' }, leo.riskHeaders()],
  ];

  for (const [label, q, h] of cases) {
    const r = await probe(MATCH, q, h);
    const tag = r.status === 200 ? '✅ 200' : '❌ ' + r.status;
    line('');
    line('【' + label + '】');
    line('  ⇒ ' + tag);
    line('    body: ' + String(r.text || '').slice(0, 200).replace(/\s+/g, ' '));
    await new Promise((res) => setTimeout(res, 1600));
  }

  hr('结论');
  line('  · 若 App 口径 400、pk-node 口径 200 ⇒ PkProtocol 的参数表就是 PK 出题失败的原因');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });