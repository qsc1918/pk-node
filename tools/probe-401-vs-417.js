#!/usr/bin/env node
'use strict';
/**
 * 破解「App 拿到 401、pk-node 拿到 417」的不一致。
 *
 * ## 现象
 *
 *   真机 App：GET /leo-profile/android/user-infos/batchGet → **401** unauthorized
 *   pk-node ：同一套 cookie、同 path、version=3.140.1 → **417** solar-encoder
 *
 * 两者本该一致（都该被 solar-encoder 的版本校验拦成 417）。差异只能是
 * **请求头/参数** 让判定走进了不同分支。
 *
 * ## 做法
 *
 * 以「version=3.140.1 → 417」为已知基线，**逐项加上 App 特有的东西**，
 * 看哪一项把它变成 401。App 比 pk-node 多的是：
 *   · query `YFD_U`（AuthInterceptor 注入）
 *   · `X-App-Version` / `X-Channel`
 *   · `x-shepherd-did`
 *   · 没有 `Accept-Encoding`
 *   · UA 用 Android <SDK_INT>
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const cookies = JSON.parse(fs.readFileSync('/tmp/dev_cookies.json', 'utf8'));
const PATHNAME = '/leo-profile/android/user-infos/batchGet';
const YFD_U = '1157242893';

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

/**
 * @param {object} o
 * @param {boolean} [o.yfdU]        加 YFD_U query
 * @param {object}  [o.extraHeaders]
 * @param {boolean} [o.stripAcceptEncoding]
 */
async function probe(o = {}) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
  const u = new URL(leo.buildUrl(PATHNAME, {}, {}));
  u.searchParams.set('version', '3.140.1');     // 已知 → 417
  if (o.yfdU) u.searchParams.set('YFD_U', YFD_U);

  const headers = Object.assign(leo.mainDomainHeaders(), o.extraHeaders || {});
  if (o.stripAcceptEncoding) {
    // request() 默认会加 Accept-Encoding: gzip，这里无法直接去掉，
    // 用显式空值覆盖会被 Node 忽略 —— 只作说明，不影响本实验结论。
    headers['Accept-Encoding'] = 'identity';
  }

  try {
    const r = await request({ url: u.toString(), method: 'GET', jar, headers });
    return { status: r.status, text: r.text, blockBy: r.headers && r.headers['x-block-by'] };
  } catch (e) {
    return { status: -1, text: String((e && e.message) || e) };
  }
}

function show(label, r) {
  const tag = r.status === 200 ? '✅ 200' : '❌ ' + r.status;
  line('  ' + label.padEnd(46) + ' → ' + tag +
    (r.blockBy ? '   x-block-by=' + r.blockBy : ''));
}

(async () => {
  hr('基线：version=3.140.1，pk-node 原始头');
  show('原样', await probe({}));

  hr('逐项加上 App 特有的东西');
  show('① + query YFD_U', await probe({ yfdU: true }));
  show('② + X-App-Version/X-Channel',
    await probe({ extraHeaders: { 'X-App-Version': '3.141.1', 'X-Channel': 'official' } }));
  show('③ + x-shepherd-did',
    await probe({ extraHeaders: { 'x-shepherd-did': 'DUtA-DmaWBaa-xgaLMMFCl5fjJG__ajuzNf3' } }));
  show('④ UA → Android 37 形态', await probe({
    extraHeaders: { 'User-Agent': 'Leo/3.140.1 (Redmi25053RT47C; Android 37; Scale/3.25)' },
  }));
  show('⑤ 全部一起上（最接近 App）', await probe({
    yfdU: true,
    extraHeaders: {
      'X-App-Version': '3.141.1',
      'X-Channel': 'official',
      'x-shepherd-did': 'DUtA-DmaWBaa-xgaLMMFCl5fjJG__ajuzNf3',
      'User-Agent': 'Leo/3.140.1 (Redmi25053RT47C; Android 37; Scale/3.25)',
    },
  }));

  hr('对照：同样组合但 version=3.141.1');
  {
    const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
    const u = new URL(leo.buildUrl(PATHNAME, {}, {}));
    u.searchParams.set('YFD_U', YFD_U);
    const r = await request({
      url: u.toString(), method: 'GET', jar,
      headers: Object.assign(leo.mainDomainHeaders(), {
        'X-App-Version': '3.141.1', 'X-Channel': 'official',
      }),
    });
    show('version=3.141.1 + YFD_U', { status: r.status, text: r.text, blockBy: r.headers['x-block-by'] });
  }

  hr('判定');
  line('  · 若某一项把 417 变成 401 ⇒ 说明 solar-encoder 的版本判定被绕过，');
  line('    401 来自 leo-auth —— App 的 401 就能解释了');
  line('  · 若全是 417 ⇒ App 的 401 另有原因（可能设备上跑的不是这份源码）');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });