#!/usr/bin/env node
'use strict';
/**
 * 校验 H5_INJECT 注入脚本的语法与运行期正确性。
 *
 * 注入脚本内嵌在 Node 模板字符串里，有两个隐蔽陷阱：
 *  1. 模板字符串里**不能出现反引号**（会提前结束字符串）；
 *  2. 里面的**正则字面量会被外层处理**（`\/` → `/`，导致正则提前结束；
 *     `${` 会被当插值）。
 * 任一都会让整段 hook 失效却只表现为「按钮点不动/加载不出来」。
 * 每次改注入脚本后跑一次 `node tools/check-inject.js`。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pk-h5-proxy.js'), 'utf8');

// 从源码里把 H5_INJECT 那段模板字符串抽出来（按 const H5_INJECT = ` ... `; 匹配）
const start = src.indexOf('const H5_INJECT = `');
if (start < 0) { console.error('✗ 未找到 H5_INJECT'); process.exit(1); }
const bodyStart = start + 'const H5_INJECT = `'.length;
// 找结束的反引号（模板字符串里不应再有反引号，所以第一个就是结束）
const end = src.indexOf('`;', bodyStart);
if (end < 0) { console.error('✗ H5_INJECT 未正常结束（可能内部有反引号）'); process.exit(1); }
const code = src.slice(bodyStart, end);

console.log('H5_INJECT 长度:', code.length);

// --- 1) 反引号检查 ---
if (code.indexOf('`') >= 0) {
  console.error('✗ 注入脚本内含反引号 —— 会破坏外层模板字符串！');
  process.exit(1);
}
console.log('✓ 无反引号');

// --- 2) 危险转义「警告」（不拦截；真正的判据是下面的语法检查）---
//
// 只找真正会出问题的形态：非注释行里出现「反斜杠 + 斜杠/问号/括号」，
// 因为模板字符串会把 `\/` 变成 `/`、`\?` 变成 `?`，从而破坏正则字面量。
// 块注释 /* */ 与普通正则（不含反斜杠）不受影响，这里不报。
const escWarn = [];
code.split('\n').forEach((line, i) => {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || /\/\*.*\*\//.test(t)) return;
  if (/\\[/?()[\]{}]/.test(line)) escWarn.push('  第' + (i + 1) + '行: ' + t.slice(0, 110));
});
if (escWarn.length) {
  console.warn('⚠ 含「反斜杠+斜杠/问号」转义，模板字符串会吞掉反斜杠（建议改用字符串 API）：');
  escWarn.slice(0, 8).forEach((s) => console.warn(s));
} else {
  console.log('✓ 无危险转义');
}

// --- 3) 语法检查 ---
try {
  new vm.Script(code, { filename: 'H5_INJECT.js' });
  console.log('✓ 语法通过');
} catch (e) {
  console.error('✗ 语法错误:', e.message);
  process.exit(1);
}

// --- 4) 运行期检查（最小浏览器桩）---
const sandbox = {
  navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 10) Chrome/151 Mobile Safari/537.36', sendBeacon: () => true },
  location: { href: 'http://127.0.0.1:8791/pk-h5/pk.html' },
  XMLHttpRequest: function () {},
  console: { log() {}, warn() {}, error() {} },
  JSON, URL, setTimeout, clearInterval, clearTimeout,
  // setInterval 用 stub：真实现会保持事件循环，导致本脚本不退出
  setInterval: () => 0,
  Date, Object, Array, String, Math, Error, Promise, Map, Set, RegExp,
  // 面板/自动化相关的最小桩（注入脚本会自动建面板与定时器）
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: {
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, children: [] }),
    createTextNode: () => ({}),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: null, head: { appendChild() {} },
  },
  PointerEvent: function () {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
};
sandbox.window = sandbox;
sandbox.XMLHttpRequest.prototype = {
  open() {}, send() {}, setRequestHeader() {}, addEventListener() {},
  status: 0, responseText: '',
};
sandbox.addEventListener = () => {};
sandbox.__PK_LEO_ID = '22';

try {
  vm.createContext(sandbox);
  new vm.Script(code).runInContext(sandbox);
} catch (e) {
  console.error('✗ 运行期异常:', e.message);
  process.exit(1);
}

const bridges = Object.keys(sandbox).filter((k) => /Web[vV]iew/.test(k) || k === 'WebView');
console.log('✓ 运行期无异常');
console.log('  挂载的桥:', bridges.length ? bridges.join(', ') : '(无)');
console.log('  __pkH5Hook:', sandbox.__pkH5Hook ? '✓' : '✗ 缺失');
console.log('  window.__pkDiag:', typeof sandbox.__pkDiag === 'function' ? '✓' : '✗');

if (!sandbox.__pkH5Hook) { console.error('✗ __pkH5Hook 未设置'); process.exit(1); }
const need = ['WebView', 'CommonWebView', 'LeoWebView'];
const missing = need.filter((n) => !sandbox[n]);
if (missing.length) { console.error('✗ 缺少桥：' + missing.join(', ')); process.exit(1); }

// --- 5) 桥协议检查（严格按 H5 的真实调用方式）---
//
// ## H5 实际怎么调（逐行读 H5 得出）
//
//   payload = base64(JSON.stringify({ arguments:[{trigger:'<m>_<ts>_<n>', ...}], callback:'...' }))
//   window.CommonWebView.<method>(payload)          // 路径 A
//   window.LeoWebView.callNative(payload)           // 路径 B（payload.method = 'common_xxx'）
//
//   回调：window[<trigger>]( base64( JSON.stringify([err, ...data]) ) )
//   —— 旧实现直接 cb(JSON.stringify(out))，Promise 永不 resolve，点击静默无反应。
try {
  const captured = { href: '' };
  const ctx = vm.createContext({
    navigator: sandbox.navigator,
    XMLHttpRequest: sandbox.XMLHttpRequest,
    console: sandbox.console,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    JSON, URL, setTimeout, clearTimeout, clearInterval,
    // setInterval 用 stub：真实现会保持事件循环，导致本脚本不退出
    setInterval: () => 0,
    Date, Object, Array, String, Math, Error, Promise, Map, Set, RegExp,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, children: [] }),
      createTextNode: () => ({}),
      querySelector: () => null,
      querySelectorAll: () => [],
      body: null, head: { appendChild() {} },
    },
    PointerEvent: function () {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    addEventListener: () => {},
    __PK_LEO_ID: '22',
  });
  ctx.window = ctx;
  Object.defineProperty(ctx, 'location', {
    configurable: true,
    get() {
      return {
        origin: 'http://127.0.0.1:8791',
        get href() { return captured.href; },
        set href(v) { captured.href = v; },
      };
    },
    set() {},
  });
  vm.runInContext(code, ctx);

  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

  // (a) getWebViewInfo：探测必须成功回调，否则 H5 判定「不支持」→ 后续 openSchema 根本不发
  let infoOut = null;
  ctx.getWebViewInfo_1_2 = (b64Result) => { infoOut = JSON.parse(unb64(b64Result)); };
  ctx.CommonWebView.getWebViewInfo(b64(JSON.stringify({
    arguments: [{ trigger: 'getWebViewInfo_1_2' }],
  })));
  if (!infoOut || infoOut[0] !== null || !infoOut[1] || !infoOut[1].version) {
    console.error('✗ getWebViewInfo 回调不符合协议，得到:', JSON.stringify(infoOut));
    process.exit(1);
  }
  console.log('✓ getWebViewInfo 回调正确:', JSON.stringify(infoOut[1]));

  // (a2) Buffer polyfill：H5 的回调解析器用的是 new Buffer(t,'base64') ——
  //      注入脚本装完 polyfill 之后，ctx 上应该已经有 Buffer 了。
  //      这里直接用「H5 的写法」解析一次，验证 polyfill 真的可用。
  if (typeof ctx.Buffer !== 'function') {
    console.error('✗ Buffer polyfill 未安装');
    process.exit(1);
  }
  const rawCb = {};
  ctx.getWebViewInfo_7_8 = (b64Result) => {
    // 完全模拟 H5 的 pt()：new Buffer(t,'base64').toString()
    rawCb.parsed = JSON.parse(new ctx.Buffer(b64Result, 'base64').toString());
  };
  ctx.CommonWebView.getWebViewInfo(b64(JSON.stringify({
    arguments: [{ trigger: 'getWebViewInfo_7_8' }],
  })));
  if (!rawCb.parsed || rawCb.parsed[0] !== null) {
    console.error('✗ Buffer polyfill 未生效（H5 回调会炸 "Buffer is not defined"）');
    process.exit(1);
  }
  console.log('✓ Buffer polyfill 生效（H5 的 new Buffer(b64,"base64") 可用）');

  // (b) openSchema：必须触发跳转
  const target = 'http://127.0.0.1:8791/pk-h5/exercise.html?pointId=1';
  const schema = 'native://openWebView?url=' + encodeURIComponent(target) + '&hideNavigation=true';
  ctx.openSchema_3_4 = () => {};
  ctx.CommonWebView.openSchema(b64(JSON.stringify({
    arguments: [{ trigger: 'openSchema_3_4', schemas: [schema] }],
  })));
  if (captured.href.indexOf('exercise.html') < 0) {
    console.error('✗ openSchema 未产生预期跳转，实际:', JSON.stringify(captured.href));
    process.exit(1);
  }
  console.log('✓ openSchema 跳转正确:', captured.href.slice(0, 80));

  // (b2) 外部 H5 地址必须被折回本机同源，
  //      否则跳过去脱离代理 → 没有 hook 与桥 → 下级页面完全哑掉。
  captured.href = '';
  const ext = 'https://xyks.yuanfudao.com/bh5/leo-web-oral-pk/exercise.html?pointId=22&jumpTime=1';
  ctx.openSchema_9_10 = () => {};
  ctx.CommonWebView.openSchema(b64(JSON.stringify({
    arguments: [{ trigger: 'openSchema_9_10', schemas: ['native://openWebView?url=' + encodeURIComponent(ext)] }],
  })));
  if (captured.href.indexOf('127.0.0.1:8791/pk-h5-cdn/leo-web-oral-pk/exercise.html') < 0) {
    console.error('✗ 外部 H5 未折回同源（下级页面会哑），实际:', JSON.stringify(captured.href));
    process.exit(1);
  }
  console.log('✓ 外部 H5 折回同源:', captured.href.slice(0, 80));

  // (c2) requestConfig：H5 在 App UA 下靠它替换 {client}，
  //      走 LeoSecure 模块。回 { wrappedUrl } 才行，回 METHOD_NOT_SUPPORT
  //      会让 H5 用**原样 URL**（含 %7Bclient%7D）→ 所有接口 404。
  let rcOut = null;
  ctx.requestConfig_11_12 = (b64Result) => { rcOut = JSON.parse(unb64(b64Result)); };
  ctx.LeoSecureWebView.callNative(b64(JSON.stringify({
    method: 'LeoSecure_requestConfig',
    params: { path: '/leo-game-pk/{client}/math/pk/home', trigger: 'requestConfig_11_12' },
  })));
  if (!rcOut || rcOut[0] !== null || !rcOut[1] || rcOut[1].wrappedUrl !== '/leo-game-pk/api/math/pk/home') {
    console.error('✗ requestConfig 未替换 {client}，得到:', JSON.stringify(rcOut));
    process.exit(1);
  }
  console.log('✓ requestConfig 替换 {client} →', rcOut[1].wrappedUrl);

  // (c) 未知方法也必须回调（否则 Promise 挂起，整条链路卡死）。
  //     注意：H5 的路径 A 是 `St[g] && St[g][method]` —— 方法不在对象上时它会
  //     fallback 到 LeoWebView.callNative，所以未知方法走的是路径 B。
  let missOut = null;
  ctx.someUnknown_5_6 = (b64Result) => { missOut = JSON.parse(unb64(b64Result)); };
  ctx.LeoWebView.callNative(b64(JSON.stringify({
    method: 'common_someUnknownMethod',
    params: { trigger: 'someUnknown_5_6' },   // H5: vt({method:y, params:e.arguments[0]})
  })));
  if (!missOut || missOut[0] !== 'METHOD_NOT_SUPPORT') {
    console.error('✗ 未知方法未按协议回调，得到:', JSON.stringify(missOut));
    process.exit(1);
  }
  console.log('✓ 未知方法回调 METHOD_NOT_SUPPORT（走 callNative 路径）');
} catch (e) {
  console.error('✗ 桥行为校验异常:', e.message);
  process.exit(1);
}

// --- 6) 模板渲染检查 ---
//
// 第 3 步的 `new vm.Script(code)` 检查的是**源码文本**。而 `code` 是
// 模板字符串里的字面内容 —— 在源码里写 `\/` 是**合法**的 JS，
// 但模板字符串求值时 `\/` 会变成 `/`，**服务端真正吐给浏览器的 JS 就坏了**：
//
//     var m = low.match(/^https?:\/\/([^\/]+)/);   ← 源码（合法）
//     var m = low.match(/^https?://([^/]+)/);      ← 实际输出（语法错误！）
//
// 所以这一步直接**跑真实的模板求值**，再对结果做语法检查。
try {
  const tplStart = start + 'const H5_INJECT = '.length;   // 含反引号
  const render = new Function('return ' + src.slice(tplStart, end + 1) + ';');
  const rendered = render();
  new vm.Script(rendered, { filename: 'H5_INJECT.rendered.js' });
  console.log('✓ 模板渲染后语法通过（' + rendered.length + ' 字节）');

  // 顺手断言：输出里不应再残留 `\/`（说明有人又写了正则字面量转义）
  if (rendered.indexOf('\\/') >= 0) {
    const at = rendered.indexOf('\\/');
    console.error('✗ 渲染结果里残留 \\/ —— 可能有正则字面量被外层模板破坏：');
    console.error('   …' + rendered.slice(Math.max(0, at - 60), at + 60) + '…');
    process.exit(1);
  }
  console.log('✓ 渲染结果无残留 \\/');
} catch (e) {
  console.error('✗ 模板渲染后语法错误（浏览器里整段 hook 会失效！）:', e.message);
  process.exit(1);
}

console.log('\n全部通过 ✅');
