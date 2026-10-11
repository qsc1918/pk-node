#!/usr/bin/env node
'use strict';
/**
 * 穷尽对照：找到「App 401 / 服务端 200」的那个变量。
 *
 * ## 已知
 *
 *   · 同一套 cookie，pk-node 打 batchGet / switch **全 200**
 *   · App 打同两个端点 **恒 401**（body=unauthorized）
 *   · 同会话下 context / profile 都是 200
 *
 * ## 本轮思路
 *
 * 不再猜「哪个参数」，而是**把 App 可能发出的形态全枚举一遍**，
 * 找出唯一挂掉的那个组合。变量维度：
 *
 *   A. version        : 3.141.1 / 3.140.1
 *   B. sign           : 有 / 无
 *   C. YFD_U          : 无 / 正确值 / 错误值
 *   D. Cookie 头组装  : jar 自动 / 全量手工 / 只 ks_* / 只 sid+userid
 *   E. Host 头 / UA   : 默认 / 带 Origin
 *   F. _productId     : 611 / 241
 *
 * 重点验证 D —— `loadForRequest` 的 hostOnly 分支若走错，
 * 发出去的 Cookie 头会**少掉 ks_***，而不带设备的请求正是 401。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const native = require(path.join(ROOT, 'src', 'native'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const raw = JSON.parse(fs.readFileSync('/tmp/dev_cookies_now.json', 'utf8'));
const BATCH = '/leo-profile/android/user-infos/batchGet';
const SWITCH = '/leo-gateway/android/accounts/switch';

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(92)); line(t); line('='.repeat(92)); }

/** 按 OkHttp 语义过滤 cookie（模拟 App 的 loadForRequest）。 */
function selectCookies(mode) {
  const HOST = 'xyks.yuanfudao.com';
  const out = [];
  for (const c of raw) {
    const d = String(c.domain || '');
    const hostOnly = !!c.hostOnly;
    let reach;
    if (hostOnly) reach = (d === HOST);
    else {
      const dd = d.replace(/^\./, '');
      reach = (HOST === dd) || HOST.endsWith('.' + dd);
    }
    if (!reach) continue;
    if (mode === 'ks_only' && !c.name.startsWith('ks_')) continue;
    if (mode === 'no_ks' && c.name.startsWith('ks_')) continue;
    if (mode === 'sid_userid' && !['sid', 'userid'].includes(c.name)) continue;
    out.push(c);
  }
  return out;
}

function cookieHeader(mode) {
  if (mode === 'jar') return null;          // 交给 CookieJar
  return selectCookies(mode).map((c) => c.name + '=' + c.value).join('; ');
}

async function hit(o) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(raw)));
  const u = new URL('https://xyks.yuanfudao.com' + o.path);
  u.searchParams.set('_productId', o.productId || '611');
  u.searchParams.set('platform', 'android37');
  u.searchParams.set('version', o.version || '3.141.1');
  u.searchParams.set('vendor', 'UC');
  u.searchParams.set('av', '5');
  u.searchParams.set('deviceCategory', 'phone');
  u.searchParams.set('webviewVersion', '150');
  u.searchParams.set('whRatio', '2.17');
  u.searchParams.set('isBackground', '0');
  if (o.yfdU) u.searchParams.set('YFD_U', o.yfdU);
  if (o.sign !== false) {
    u.searchParams.set('sign', native.calcSign(o.path, { version: o.version || '3.141.1' }));
  }

  const headers = leo.mainDomainHeaders();
  const ck = cookieHeader(o.cookieMode || 'jar');
  if (ck != null) headers.Cookie = ck;

  try {
    const r = await request({
      url: u.toString(),
      method: o.method || 'GET',
      jar: ck == null ? jar : undefined,
      body: o.body,
      headers,
    });
    return { status: r.status, text: r.text };
  } catch (e) {
    return { status: -1, text: String((e && e.message) || e) };
  }
}

function show(label, r) {
  const tag = r.status === 200 ? '✅ 200' : '❌ ' + r.status;
  line('  ' + label.padEnd(52) + tag +
    (r.status !== 200 ? '  ' + String(r.text).slice(0, 56).replace(/\s+/g, ' ') : ''));
}

(async () => {
  hr('batchGet —— 变量枚举');
  show('基线（jar 自动带全量 cookie）', await hit({ path: BATCH }));
  await new Promise((r) => setTimeout(r, 900));
  show('只剩 ks_*（丢掉 sid/userid）', await hit({ path: BATCH, cookieMode: 'ks_only' }));
  await new Promise((r) => setTimeout(r, 900));
  show('丢掉 ks_*（只留其余）★重点', await hit({ path: BATCH, cookieMode: 'no_ks' }));
  await new Promise((r) => setTimeout(r, 900));
  show('只剩 sid+userid', await hit({ path: BATCH, cookieMode: 'sid_userid' }));
  await new Promise((r) => setTimeout(r, 900));
  show('+ YFD_U', await hit({ path: BATCH, yfdU: '511467407' }));
  await new Promise((r) => setTimeout(r, 900));
  show('_productId=241', await hit({ path: BATCH, productId: '241' }));
  await new Promise((r) => setTimeout(r, 900));
  show('无 sign', await hit({ path: BATCH, sign: false }));

  hr('switch —— 变量枚举（POST + form）');
  const form = 'targetUserId=1157242893';
  show('基线', await hit({
    path: SWITCH, method: 'POST', body: form,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
  }));
  await new Promise((r) => setTimeout(r, 1200));
  show('丢掉 ks_* ★重点', await hit({
    path: SWITCH, method: 'POST', body: form, cookieMode: 'no_ks',
  }));

  hr('判定');
  line('  · 若「丢掉 ks_*」= 401 而基线 200 ⇒ 根因是 Cookie 头里没有 ks_*');
  line('    即 App 的 loadForRequest 把 ks_* 过滤掉了');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });