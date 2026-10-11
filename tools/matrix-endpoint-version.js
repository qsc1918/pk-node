#!/usr/bin/env node
'use strict';
/**
 * 端点 × version 矩阵 —— 判定 `version` 是不是**每个端点各自**的白名单。
 *
 * ## 为什么要做这个
 *
 * 真机日志里出现自相矛盾的现象：
 *
 *     /leo-star/android/exercise/rank/pre-fetch    → 200   ← 主域，version=3.140.1
 *     /leo-star/android/exercise/homepage          → 200   ← 主域，version=3.140.1
 *     /leo-profile/api/user-infos/context          → 200   ← 主域，version=3.140.1
 *     /leo-profile/android/user-infos/batchGet     → 401   ← 主域，version=3.140.1
 *     /leo-math/.../exercises/type/0               → 401   ← 主域，version=3.140.1
 *
 * 而 pk-node 侧同一套 cookie、同一 path、version=3.140.1 → **417**。
 *
 * 若「3.140.1 全不支持」，前三条不该 200；
 * 若「3.140.1 全支持」，后两条不该挂。
 * ⇒ 唯一自洽的解释是**白名单按服务（x-yfd-service）分别维护**。
 *
 * 本实验把每个端点都跑一遍 3.140.1 / 3.141.1，得到真实的放行表。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const cookies = JSON.parse(fs.readFileSync('/tmp/dev_cookies.json', 'utf8'));

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(92)); line(t); line('='.repeat(92)); }

/** 端点清单：path + 业务参数 + 方法。 */
const ENDPOINTS = [
  ['/leo-star/android/exercise/rank/pre-fetch', {}, 'GET', '真机 200'],
  ['/leo-star/android/exercise/homepage', {}, 'GET', '真机 200'],
  ['/leo-profile/api/user-infos/context', { _productId: '241' }, 'GET', '真机 200'],
  ['/leo-profile/android/user-infos/batchGet', {}, 'GET', '真机 401 ★ 名字/头像'],
  ['/leo-math/android/exams/exercises/type/0', { grade: '13', semester: '1', book: '1' }, 'GET', '真机 401 ★ 知识点'],
];

async function probe(pathname, params, method, version) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
  const u = new URL(leo.buildUrl(pathname, params, {}));
  u.searchParams.set('version', version);
  if (params._productId) u.searchParams.set('_productId', params._productId);
  try {
    const r = await request({
      url: u.toString(), method, jar, headers: leo.mainDomainHeaders(),
    });
    return { status: r.status, block: r.headers && r.headers['x-block-by'],
      svc: r.headers && r.headers['x-yfd-service'] };
  } catch (e) {
    return { status: -1, err: String((e && e.message) || e) };
  }
}

(async () => {
  hr('端点 × version 矩阵');

  const VERS = ['3.140.1', '3.141.1'];

  for (const [pathname, params, method, note] of ENDPOINTS) {
    line('');
    line('【' + pathname + '】  ' + note);
    for (const v of VERS) {
      const r = await probe(pathname, params, method, v);
      const tag = r.status === 200 ? '✅ 200' : '❌ ' + r.status;
      line('    version=' + v + '  → ' + tag +
        (r.block ? '   x-block-by=' + r.block : '') +
        (r.svc ? '   svc=' + r.svc : '') +
        (r.err ? '   err=' + r.err : ''));
      await new Promise((res) => setTimeout(res, 1100));
    }
  }

  hr('判定');
  line('  · 某端点 3.140.1 → 417、3.141.1 → 200 ⇒ 该服务已不认 3.140.1');
  line('  · 若真机 200 的两个端点在这里也是 3.140.1 → 200 ⇒ 印证「按服务分表」');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });