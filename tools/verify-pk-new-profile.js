#!/usr/bin/env node
'use strict';
/**
 * 端到端验证：**新口径**（与主域统一）能否真的打通 PK 出题。
 *
 * ## 被验证的改动
 *
 * `PkProtocol` 从「两套表」改成「与主域统一」：
 *
 * | 参数 | 旧（两套表） | 新（统一） |
 * |---|---|---|
 * | `version` | 3.143.1 | **3.141.1** |
 * | `platform` | android35 | **android37** |
 * | `vendor` | fenbi | **UC** |
 * | `webviewVersion` | 110 | **150** |
 * | `whRatio` | 1.78 | **2.17** |
 * | sign 资产 | lre_pk.so | **lre.so（exercise）** |
 *
 * ## 对照
 *
 *   ① pk-node 现链路（它就是这么做的，已知 200）
 *   ② 手工构造「新口径」，但**不带 sign** → 应 417（证明没 sign 不行）
 *   ③ 手工构造「新口径」+ 正确 sign → 应 200
 *
 * ②③ 的差就是 sign 是不是按 version 选的验证。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const leo = require(path.join(ROOT, 'src', 'leo'));
const native = require(path.join(ROOT, 'src', 'native'));

const cookies = JSON.parse(fs.readFileSync('/tmp/dev_cookies.json', 'utf8'));

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

const POINT = 70;
const PK_MATCH_V2 = '/leo-game-pk/android/math/pk/match/v2';

/** 新口径（App 改完后应当发的就是这套）。 */
const NEW_Q = [
  ['_productId', '611'],
  ['platform', 'android37'],
  ['version', '3.141.1'],
  ['vendor', 'UC'],
  ['av', '5'],
  ['deviceCategory', 'phone'],
  ['webviewVersion', '150'],
  ['whRatio', '2.17'],
];

const H5_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 15; DCO-AL00 Build/V417IR; wv) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 ' +
    'Mobile Safari/537.36 YuanSouTiKouSuan/3.141.1',
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/x-www-form-urlencoded',
  Origin: 'https://xyks.yuanfudao.com',
  'X-Requested-With': 'com.fenbi.android.leo',
  Referer: 'https://xyks.yuanfudao.com/bh5/leo-web-oral-pk/exercise.html',
};

function buildNewUrl(withSign) {
  const sp = new URLSearchParams();
  for (const [k, v] of NEW_Q) sp.set(k, v);
  sp.set('pointId', String(POINT));
  sp.set('triggerPeakMatch', '0');
  if (withSign) {
    // 按 version=3.141.1 → exercise 资产（就是 pk-node 的默认行为）
    const sign = native.calcSign(PK_MATCH_V2, { version: '3.141.1' });
    sp.set('sign', sign);
  }
  return 'https://xyks.yuanfudao.com' + PK_MATCH_V2 + '?' + sp.toString();
}

(async () => {
  hr('① pk-node 现链路（基线，应 200）');
  {
    const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
    const r = await leo.pkMatchV2(jar, POINT, {});
    line('  ' + (r.status === 200 ? '✅' : '❌') + ' HTTP ' + r.status);
    line('    ' + String(r.text || '').slice(0, 150).replace(/\s+/g, ' '));
  }

  await new Promise((r) => setTimeout(r, 2000));

  hr('② 新口径 **不带 sign**（应 417 —— 证明 sign 仍是必需）');
  {
    const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
    const r = await request({
      url: buildNewUrl(false), method: 'POST', jar, rawBody: true, headers: H5_HEADERS,
    });
    line('  ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
      (r.headers['x-block-by'] ? '   x-block-by=' + r.headers['x-block-by'] : ''));
  }

  await new Promise((r) => setTimeout(r, 2000));

  hr('③ 新口径 **带正确 sign**（version=3.141.1 → exercise 资产，应 200）');
  {
    const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
    const r = await request({
      url: buildNewUrl(true), method: 'POST', jar, rawBody: true, headers: H5_HEADERS,
    });
    line('  ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
      (r.headers['x-block-by'] ? '   x-block-by=' + r.headers['x-block-by'] : ''));
    line('    ' + String(r.text || '').slice(0, 150).replace(/\s+/g, ' '));
  }

  hr('④ 反证：新口径 version=3.141.1 但用 **PK 资产**算 sign（应 417 —— 证明错配会挂）');
  {
    const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
    const badSign = native.calcSign(PK_MATCH_V2, { variant: 'pk' });   // 故意用 pk 资产
    const url = new URL(buildNewUrl(false));
    url.searchParams.set('sign', badSign);
    const r = await request({
      url: url.toString(), method: 'POST', jar, rawBody: true, headers: H5_HEADERS,
    });
    line('  ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
      (r.headers['x-block-by'] ? '   x-block-by=' + r.headers['x-block-by'] : ''));
  }

  hr('判定');
  line('  · ③ 200 且 ④ 417 ⇒ 「按 version 选资产」这条规则被证实，App 的改动正确');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });