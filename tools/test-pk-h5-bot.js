#!/usr/bin/env node
'use strict';
/**
 * PK H5「三个自动能力」的离线回归测试。
 *
 * 守三个真 bug：
 *  1. 能力参数丢失：`?pkbot=` 只挂入口页，跳到子页面后开关全关 → recognize 回空串 → 手写正确符号也判错。
 *  2. 模拟笔迹事件类型错：手写板只绑 mouse/touch，注入脚本原来只发 PointerEvent → 一笔都进不去。
 *  3. 「自动下一局」找按钮漏了「再练一次」，却把「返回首页」也算进来（点了等于离开）。
 *
 * 用法：`node tools/test-pk-h5-bot.js`
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pk-h5-proxy.js'), 'utf8');
const start = src.indexOf('const H5_INJECT = `');
const bodyStart = start + 'const H5_INJECT = `'.length;
const end = src.indexOf('`;', bodyStart);
const code = src.slice(bodyStart, end);

let failed = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  [OK]   ' + name + (extra ? ' → ' + extra : '')); }
  else { failed++; console.error('  [FAIL] ' + name + (extra ? ' → ' + extra : '')); }
}

/** 造一个最小浏览器环境并跑注入脚本。 */
function makeSandbox(opts) {
  const o = opts || {};
  const store = Object.assign({}, o.storage || {});
  const navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36', sendBeacon: () => true };
  const document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, children: [] }),
    createTextNode: () => ({}),
    querySelector: (sel) => (o.canvas ? o.canvas : null),
    querySelectorAll: () => (o.nodes || []),
    body: null,
    head: { appendChild() {} },
  };
  const sb = {
    navigator, document,
    // 注入脚本的 base64 编解码走 window.btoa/atob —— 真实浏览器里有，沙箱里要自己补
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    XMLHttpRequest: function () {},
    console: { log() {}, warn() {}, error() {} },
    JSON, URL, Date, Object, Array, String, Math, Error, Promise, Map, Set, RegExp, Number,
    setTimeout, clearTimeout, clearInterval,
    setInterval: () => 0,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      key: () => null,
      get length() { return Object.keys(store).length; },
    },
    __pkStore: store,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    addEventListener: () => {},
    PointerEvent: function () {},
    MouseEvent: function (t, i) { this.type = t; Object.assign(this, i || {}); this.dispatched = true; },
    Touch: function (i) { Object.assign(this, i || {}); },
    TouchEvent: function (t, i) { this.type = t; Object.assign(this, i || {}); },
  };
  if (o.canvas) {
    sb.MouseEvent = function (t, i) { this.type = t; Object.assign(this, i || {}); };
  }
  sb.XMLHttpRequest.prototype = { open() {}, send() {}, setRequestHeader() {}, addEventListener() {}, status: 0, responseText: '' };
  sb.window = sb;
  // 真实环境里这两行是 rewriteHtml 注入的（hook 之外），沙箱里手动补上
  sb.__PK_LEO_ID = o.leoId === undefined ? '6' : o.leoId;
  // 'ontouchstart' in window 的控制开关（注入脚本用它决定发 touch 还是 mouse）
  if (o.touch) sb.ontouchstart = null;
  // location（只有 href/origin/search/pathname 会被用到）
  // 注意：search 默认从 href 里现取 —— 否则「URL 带 pkbot」的用例永远读不到参数。
  const href = String(o.href || '');
  const qi = href.indexOf('?');
  const derivedSearch = qi >= 0 ? href.slice(qi) : '';
  Object.defineProperty(sb, 'location', {
    configurable: true,
    get() {
      return {
        origin: 'http://127.0.0.1:8792',
        href: href,
        search: o.search == null ? derivedSearch : o.search,
        pathname: o.pathname || '/pk-h5/pk.html',
      };
    },
    set() {},
  });
  vm.createContext(sb);
  vm.runInContext(code, sb);
  return sb;
}

/** 取 base64 回调结果。 */
function callBridge(sb, method, module, params, cbName) {
  let out = null;
  sb[cbName] = (b64) => { out = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); };
  const payload = { method: module + '_' + method, params: Object.assign({}, params, { trigger: cbName }) };
  sb.LeoWebView.callNative(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'));
  return out;
}

console.log('== PK H5 自动能力回归测试 ==\n');

/* ------------------------------------------------------------------ 1) recognize */
console.log('1) recognize 桥（「视为正确答案」是否生效）');

// 1a. 入口页 URL 带 pkbot=answer → 回 expectedResult 首项
{
  const sb = makeSandbox({ href: 'http://127.0.0.1:8792/pk-h5/pk.html?leoAccountId=6&pkbot=answer,autoStroke,autoNext' });
  const out = callBridge(sb, 'recognize', 'MathExercise', { strokes: [], keypointId: '16', expectedResult: ['>'] }, 'cb_r1');
  ok('URL 带 pkbot=answer 时回 expectedResult 首项', out && out[0] === null && out[1] === '>', JSON.stringify(out));
  ok('URL 的能力已写入 localStorage（供子页面读取）',
    String(sb.__pkStore['pk-bot-cfg'] || '').indexOf('"answer":true') >= 0, sb.__pkStore['pk-bot-cfg']);
}

// 1b. 子页面（exercise.html）URL 没有 pkbot —— 这正是原来失效的场景
{
  const sb = makeSandbox({
    href: 'http://127.0.0.1:8792/pk-h5/exercise.html?pointId=16&leoAccountId=6',
    pathname: '/pk-h5/exercise.html',
    storage: { 'pk-bot-cfg': JSON.stringify({ answer: true, autoStroke: true, autoNext: true }) },
  });
  const out = callBridge(sb, 'recognize', 'MathExercise', { strokes: [], keypointId: '16', expectedResult: ['<'] }, 'cb_r2');
  ok('子页面（URL 无 pkbot）仍回正确答案（读 localStorage）', out && out[0] === null && out[1] === '<', JSON.stringify(out));
}

// 1c. pkbot=off → 回空串（不自动作答）
{
  const sb = makeSandbox({ href: 'http://127.0.0.1:8792/pk-h5/pk.html?leoAccountId=6&pkbot=off' });
  const out = callBridge(sb, 'recognize', 'MathExercise', { strokes: [], keypointId: '16', expectedResult: ['>'] }, 'cb_r3');
  ok('pkbot=off 时回空串（不自动作答）', out && out[0] === null && out[1] === '', JSON.stringify(out));
}

/* ------------------------------------------------------- 2) 跳转时带上 pkbot */
console.log('\n2) 页面跳转时把 pkbot 带下去');

function navigate(sb, target) {
  let out = null;
  sb.cb_nav = (b64) => { out = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); };
  const schema = 'native://openWebView?url=' + encodeURIComponent(target);
  sb.CommonWebView.openSchema(Buffer.from(JSON.stringify({ arguments: [{ trigger: 'cb_nav', schemas: [schema] }] }), 'utf8').toString('base64'));
  return out;
}
{
  const sb = makeSandbox({ href: 'http://127.0.0.1:8792/pk-h5/pk.html?leoAccountId=6&pkbot=answer,autoNext' });
  // 用一个「外部域」地址，避开 location.href 赋值（沙箱里没有真实导航）
  navigate(sb, 'https://xyks.yuanfudao.com/bh5/leo-web-oral-pk/exercise.html?pointId=22');
  const href = String(sb.location.href || '');
  // 沙箱里 location.href 是 getter（只读），所以这里换个方式断言：
  // 直接调 addLeoId 的等价入口 —— openSchema 内部会拼 pkbot，用 __pkBotRaw 验证取值
  ok('__pkBotRaw() 反映入口页 URL 的能力', sb.__pkBotRaw() === 'answer,autoNext', sb.__pkBotRaw());
  // 断言拼 URL 的行为：用 pk.html 同源目标再走一次（check-inject.js 已断言跳转本身）
  const sb2 = makeSandbox({ href: 'http://127.0.0.1:8792/pk-h5/pk.html?leoAccountId=6&pkbot=answer' });
  const captured = {};
  Object.defineProperty(sb2, 'location', {
    configurable: true,
    get() { return { origin: 'http://127.0.0.1:8792', get href() { return captured.href; }, set href(v) { captured.href = v; }, search: '?leoAccountId=6&pkbot=answer', pathname: '/pk-h5/pk.html' }; },
    set() {},
  });
  navigate(sb2, 'https://xyks.yuanfudao.com/bh5/leo-web-oral-pk/exercise.html?pointId=22');
  ok('跳转 URL 含 leoAccountId', String(captured.href).indexOf('leoAccountId=6') >= 0, captured.href);
  ok('跳转 URL 含 pkbot=answer（子页面因此不再「全关」）',
    String(captured.href).indexOf('pkbot=answer') >= 0, captured.href);
}

/* ------------------------------------------------------------- 3) 自动交笔事件 */
console.log('\n3) 「自动提交画笔」发的是手写板真正监听的事件');

function fakeCanvas() {
  const el = {
    tagName: 'CANVAS',
    className: 'canvas',
    children: [],
    dispatched: [],
    dispatchEvent(ev) { this.dispatched.push(ev.type); return true; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 700 }; },
  };
  return el;
}
{
  // 3a. 非触摸环境 → mousedown/mousemove/mouseup（原来发 PointerEvent，一个都进不去）
  const el = fakeCanvas();
  const sb = makeSandbox({ href: 'http://127.0.0.1:8792/pk-h5/exercise.html', pathname: '/pk-h5/exercise.html', canvas: el, touch: false });
  const r = sb.__pkBotStroke();
  ok('非触摸环境发出 mousedown/mousemove/mouseup',
    r === true && el.dispatched[0] === 'mousedown' && el.dispatched.indexOf('mousemove') >= 0 && el.dispatched[el.dispatched.length - 1] === 'mouseup',
    el.dispatched.join(','));
  ok('不再依赖 pointerdown（手写板根本不监听它）', el.dispatched.indexOf('pointerdown') < 0, el.dispatched.join(','));
}
{
  // 3b. 触摸环境 → touchstart/touchmove/touchend
  const el = fakeCanvas();
  const sb = makeSandbox({ href: 'http://127.0.0.1:8792/pk-h5/exercise.html', pathname: '/pk-h5/exercise.html', canvas: el, touch: true });
  const r = sb.__pkBotStroke();
  ok('触摸环境发出 touchstart/touchmove/touchend',
    r === true && el.dispatched[0] === 'touchstart' && el.dispatched.indexOf('touchmove') >= 0 && el.dispatched[el.dispatched.length - 1] === 'touchend',
    el.dispatched.join(','));
}

/* --------------------------------------------------------- 4) 自动下一局按钮 */
console.log('\n4) 「自动下一局」找的是结算页的继续按钮');

function nodesFrom(texts) {
  return texts.map((t) => ({
    textContent: t,
    children: [],
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
  }));
}
for (const label of ['继续PK', '再练一次', '继续挑战', '再来一局']) {
  const sb = makeSandbox({ href: 'http://127.0.0.1:8792/pk-h5/result.html', pathname: '/pk-h5/result.html', nodes: nodesFrom([label]) });
  ok('能点中「' + label + '」', !!sb.__pkBotFindNext());
}
{
  const sb = makeSandbox({ href: 'http://127.0.0.1:8792/pk-h5/result.html', pathname: '/pk-h5/result.html', nodes: nodesFrom(['返回首页', '分享']) });
  ok('不会误点「返回首页」（那是离开按钮）', sb.__pkBotFindNext() === null);
}

/* --------------------------------------------------- 5) 出题频控重试判定 */
console.log('\n5) 代理侧对「太火爆」的频控重试判定');
{
  const proxy = require('../src/pk-h5-proxy');
  const match = '/leo-game-pk/api/math/pk/match/v2';
  ok('match 400 → 重试（H5 见 400 就弹「PK现场太火爆」）', proxy.pkRetryBudget(400, '', match) > 0);
  ok('match 429 → 重试', proxy.pkRetryBudget(429, '', match) > 0);
  ok('普通接口 401 → 只重试 1 次（别把整页拖死）', proxy.pkRetryBudget(401, '', '/leo-game-pk/api/math/pk/home') === 1);
  ok('普通接口 200 → 不重试', proxy.pkRetryBudget(200, '', '/leo-game-pk/api/math/pk/home') === 0);
  ok('响应体含「请求过于频繁」→ 重试', proxy.pkRetryBudget(200, '{"message":"请求过于频繁"}', '/x') > 0);
}

console.log('');
if (failed) { console.error('✗ 有 ' + failed + ' 项未通过'); process.exit(1); }
console.log('全部通过 ✅');
