#!/usr/bin/env node
'use strict';
/**
 * 验证「version 只放行 3.141.1」这个结论，并看 417 的响应头里有没有线索。
 *
 * ## 上一轮结果
 *
 *   version=3.141.1 → ✅ 200
 *   version=3.140.1 → ❌ 417
 *
 * 但 App 侧拿到的是 **401**（不是 417）—— 说明还有别的因素。
 * 本实验：
 *   ① 打印 417 的完整响应头（找 x-block-by 之类的判据）
 *   ② 扫几个版本号，确认 3.141.1 是唯一放行值还是区间
 *   ③ 用 App 的**完整 UA + 全部参数**再试 3.140.1，看是否仍 417
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const cookies = JSON.parse(fs.readFileSync('/tmp/dev_cookies.json', 'utf8'));
const PATHNAME = '/leo-profile/android/user-infos/batchGet';

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

async function probe(version, extraHeaders = {}) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
  const u = new URL(leo.buildUrl(PATHNAME, {}, {}));
  u.searchParams.set('version', version);
  const headers = Object.assign(leo.mainDomainHeaders(), extraHeaders);
  try {
    const r = await request({ url: u.toString(), method: 'GET', jar, headers });
    return r;
  } catch (e) {
    return { status: -1, headers: {}, text: String((e && e.message) || e) };
  }
}

(async () => {
  hr('① 打印 version=3.140.1 的完整响应头');
  const bad = await probe('3.140.1');
  line('  HTTP ' + bad.status);
  for (const [k, v] of Object.entries(bad.headers || {})) {
    if (/^(x-|set-cookie|www-authenticate|block)/i.test(k)) {
      line('    ' + k + ': ' + JSON.stringify(v));
    }
  }
  line('  body: ' + String(bad.text).slice(0, 200));

  hr('② 扫版本号，找放行区间');
  const vers = ['3.139.0', '3.140.0', '3.140.1', '3.141.0', '3.141.1', '3.142.0', '3.143.1'];
  for (const v of vers) {
    const r = await probe(v);
    line('  version=' + v.padEnd(9) + ' ⇒ ' +
      (r.status === 200 ? '✅ 200' : '❌ ' + r.status));
    await new Promise((res) => setTimeout(res, 900));
  }

  hr('③ App 完整姿态（UA 用 Android 37 + versionName 3.141.1 header）下，query 仍用 3.140.1');
  const r3 = await probe('3.140.1', {
    'User-Agent': 'Leo/3.140.1 (Redmi25053RT47C; Android 37; Scale/3.25)',
    'X-App-Version': '3.141.1',
  });
  line('  ⇒ ' + (r3.status === 200 ? '✅ 200' : '❌ ' + r3.status) +
    '  ' + String(r3.text).slice(0, 140).replace(/\s+/g, ' '));

  hr('④ 结论');
  line('  · 若 3.140.1 恒 417、3.141.1 恒 200 ⇒ App 的 LEO_PROTOCOL_VERSION 必须升级');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });