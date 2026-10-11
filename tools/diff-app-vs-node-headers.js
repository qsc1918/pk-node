#!/usr/bin/env node
'use strict';
/**
 * 差分定位：App 的 `batchGet` 是 401，pk-node 同 cookie 是 200 —— 差在哪？
 *
 * ## 已知差异（读代码得出，待实证）
 *
 * | 项 | pk-node（200） | App（401） |
 * |---|---|---|
 * | UA | `Leo/3.141.1 (brand model; Android 17; Scale/3.25)` | `Leo/3.140.1 (...; Android <SDK_INT>; ...)` |
 * | `X-App-Version` | `PK.commonQuery.version`（真机 3.141.1） | App 的 `versionName` |
 * | `version` query | PK.commonQuery.version | `3.140.1`（LEO_PROTOCOL_VERSION） |
 *
 * ## 做法
 *
 * 以 pk-node 的完整链路为基线（200），**逐项替换成 App 的取值**，
 * 看哪一项一改就变 401。一次只改一项 —— 才能定位。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const leo = require(path.join(ROOT, 'src', 'leo'));
const config = require(path.join(ROOT, 'src', 'config'));

const cookies = JSON.parse(fs.readFileSync('/tmp/dev_cookies.json', 'utf8'));

const PATHNAME = '/leo-profile/android/user-infos/batchGet';

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

/**
 * 用指定的一组覆盖项发一次 batchGet。
 *
 * @param {object} o
 * @param {string} [o.ua]            覆盖 User-Agent
 * @param {string} [o.xAppVersion]   覆盖 X-App-Version
 * @param {string} [o.queryVersion]  覆盖 query 里的 version
 * @param {string} [o.platform]      覆盖 query 里的 platform
 * @param {boolean} [o.dropSign]     是否去掉 sign
 */
async function probe(o = {}) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));

  // 用 pk-node 的 buildUrl 生成基线 URL，再按需改写 query
  let url = leo.buildUrl(PATHNAME, {}, {});
  if (o.queryVersion || o.platform) {
    const u = new URL(url);
    if (o.queryVersion) u.searchParams.set('version', o.queryVersion);
    if (o.platform) u.searchParams.set('platform', o.platform);
    url = u.toString();
  }

  const headers = leo.mainDomainHeaders();
  if (o.ua) headers['User-Agent'] = o.ua;
  if (o.xAppVersion) headers['X-App-Version'] = o.xAppVersion;

  if (o.dropSign) {
    const u = new URL(url);
    u.searchParams.delete('sign');
    url = u.toString();
  }

  try {
    const r = await request({ url, method: 'GET', jar, headers });
    return { status: r.status, text: r.text };
  } catch (e) {
    return { status: -1, text: String((e && e.message) || e) };
  }
}

(async () => {
  const PK = config.PK;
  const realVer = PK.commonQuery.version;
  const realPlatform = PK.commonQuery.platform;
  const realUa = leo.leoUserAgent();

  hr('基线（pk-node 原样）');
  line('  UA            = ' + realUa);
  line('  X-App-Version = ' + realVer);
  line('  query version = ' + realVer + '   platform = ' + realPlatform);

  const base = await probe({});
  line('  ⇒ ' + (base.status === 200 ? '✅ 200' : '❌ ' + base.status) +
    '  ' + String(base.text).slice(0, 90).replace(/\s+/g, ' '));

  hr('① 只把 UA 换成 App 的形态（Android <SDK_INT>，版本 3.140.1）');
  const appUa = 'Leo/3.140.1 (Redmi25053RT47C; Android 37; Scale/3.25)';
  const r1 = await probe({ ua: appUa });
  line('  UA = ' + appUa);
  line('  ⇒ ' + (r1.status === 200 ? '✅ 200' : '❌ ' + r1.status) +
    '  ' + String(r1.text).slice(0, 90).replace(/\s+/g, ' '));

  hr('② 只把 X-App-Version 换成 App 的 versionName');
  const r2 = await probe({ xAppVersion: '3.141.1' });
  line('  ⇒ ' + (r2.status === 200 ? '✅ 200' : '❌ ' + r2.status) +
    '  ' + String(r2.text).slice(0, 90).replace(/\s+/g, ' '));

  hr('③ 只把 query version 换成 3.140.1');
  const r3 = await probe({ queryVersion: '3.140.1' });
  line('  ⇒ ' + (r3.status === 200 ? '✅ 200' : '❌ ' + r3.status) +
    '  ' + String(r3.text).slice(0, 90).replace(/\s+/g, ' '));

  hr('④ 只把 platform 换成 android37');
  const r4 = await probe({ platform: 'android37' });
  line('  ⇒ ' + (r4.status === 200 ? '✅ 200' : '❌ ' + r4.status) +
    '  ' + String(r4.text).slice(0, 90).replace(/\s+/g, ' '));

  hr('⑤ 对照组：去掉 sign（应 417，验证实验有效）');
  const r5 = await probe({ dropSign: true });
  line('  ⇒ ' + (r5.status === 200 ? '✅ 200' : '❌ ' + r5.status) +
    '  ' + String(r5.text).slice(0, 90).replace(/\s+/g, ' '));

  hr('判定');
  line('  · 哪一项一改就变 401 ⇒ 那一项就是 App 侧的错误取值');
  line('  · 全都不变 ⇒ 差异不在这些项，继续找（头/参数/编码）');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });