#!/usr/bin/env node
'use strict';
/**
 * 定位 `POST /leo-gateway/android/accounts/switch` 的 401。
 *
 * ## 真机现象（2026-10-11 08:42，新 APK 3.141.17）
 *
 *     POST /leo-gateway/android/accounts/switch → 401   × 5 次
 *
 * 而同一会话下 `batchGet` 也还是 401。
 * 注意：`context` 与 `profile/android/user-info` 都是 200 ——
 * 说明 cookie 本身有效，**不是登录态失效**。
 *
 * ## 关键怀疑
 *
 * `batchGet` 在 pk-node 侧用同一套 cookie **实测 200**（已证）。
 * 差异只可能是请求构造。逐项比对：
 *
 *   · `YFD_U` query（App 的 AuthInterceptor 会注入）
 *   · `_productId` 位置
 *   · `version` 值
 *   · Cookie 头的**顺序 / 内容**
 *
 * 重点测「App 会发的那个形态」：带 `YFD_U`、`_productId` 最前、version=3.141.1。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const cookies = JSON.parse(fs.readFileSync('/tmp/dev_cookies_now.json', 'utf8'));

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

const BATCH = '/leo-profile/android/user-infos/batchGet';
const SWITCH = '/leo-gateway/android/accounts/switch';

async function probeBatch(label, opts = {}) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
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
  if (opts.yfdU) u.searchParams.set('YFD_U', opts.yfdU);
  // sign 必须按 path 算（不含 query）
  const sign = require(path.join(ROOT, 'src', 'native')).calcSign(BATCH, { version: '3.141.1' });
  u.searchParams.set('sign', sign);

  const headers = leo.mainDomainHeaders();
  if (opts.plainCookie) {
    // 只发「关键几条」cookie，模拟可能的裁剪
    headers.Cookie = cookies.filter((c) => c.name === 'userid' || c.name === 'sid')
      .map((c) => c.name + '=' + c.value).join('; ');
  }
  try {
    const r = await request({ url: u.toString(), method: 'GET', jar, headers });
    line('  ' + label.padEnd(40) + ' → ' +
      (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
      (r.headers['x-block-by'] ? '  block-by=' + r.headers['x-block-by'] : '') +
      (r.status !== 200 ? '  ' + String(r.text).slice(0, 70) : ''));
    return r.status;
  } catch (e) {
    line('  ' + label.padEnd(40) + ' → 异常 ' + ((e && e.message) || e));
    return -1;
  }
}

(async () => {
  hr('batchGet：手工构造「App 形态」');

  await probeBatch('新口径（无 YFD_U）');
  await new Promise((r) => setTimeout(r, 1200));
  await probeBatch('+ YFD_U=1157242893', { yfdU: '1157242893' });
  await new Promise((r) => setTimeout(r, 1200));
  await probeBatch('+ YFD_U=350266477（错误值，试）', { yfdU: '350266477' });
  await new Promise((r) => setTimeout(r, 1200));
  await probeBatch('只带 userid+sid cookie', { plainCookie: true });

  hr('对照：pk-node 现链路（应 200）');
  {
    const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
    const r = await leo.subAccountsBatchGet(jar);
    line('  pk-node subAccountsBatchGet  → ' +
      (r.status === 200 ? '✅ 200' : '❌ ' + r.status));
  }

  hr('switch：完整链路');
  {
    const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
    // 取一个子账号 ID 来切
    const ctx = await leo.userInfosContext(jar);
    const ids = ctx.json && ctx.json.allSubUserIds || [];
    line('  子账号列表：' + JSON.stringify(ids));
    const target = ids.find((x) => String(x) !== '1157242893') || ids[0];
    line('  目标：' + target);
    await new Promise((r) => setTimeout(r, 1200));
    const r = await leo.switchSubAccount(jar, target);
    line('  switch → ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
      '  ' + String(r.text).slice(0, 200).replace(/\s+/g, ' '));
  }

  hr('判定');
  line('  · 若 pk-node 的 batchGet 200 而手工构造 401 ⇒ 差异在参数/头');
  line('  · 若 switch 也 200 ⇒ App 侧构造有问题；若 401 ⇒ 该接口需额外权限');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });