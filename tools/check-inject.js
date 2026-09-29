#!/usr/bin/env node
'use strict';
/**
 * 校验 H5_INJECT 注入脚本的语法与运行期正确性。
 *
 * ## 为什么需要它（2026-09-29 的惨痛教训）
 *
 * 注入脚本是**内嵌在 Node 模板字符串里**的一段 JS，这带来两个隐蔽陷阱：
 *  1. 模板字符串里**不能出现反引号**（会提前结束字符串）；
 *  2. 里面的**正则字面量会被外层处理**（`\/` → `/`，导致正则提前结束；
 *     `${` 会被当插值）。
 *
 * 我因为它连续翻了三次车：写注释用了反引号、正则里写了 `\/`、`\?` ——
 * 每次都是「语法错误 → 整段 hook 失效 → 页面 API 不被代理、桥不存在」，
 * 而现象只是「按钮点不动/加载不出来」，极难从表象定位。
 *
 * 所以把校验固化下来：每次改注入脚本后跑一次 `node tools/check-inject.js`。
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
  JSON, URL, setTimeout, Date, Object, Array, String, Math, Error,
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
// ## H5 实际怎么调（逐行读 index-legacy.CHYoHfC0.js 得出，2026-09-29）
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
    JSON, URL, setTimeout, Date, Object, Array, String, Math, Error,
    addEventListener: () => {},
    __PK_LEO_ID: '22',
  });
  ctx.window = ctx;
  Object.defineProperty(ctx, 'location', {
    configurable: true,
    get() { return { get href() { return captured.href; }, set href(v) { captured.href = v; } }; },
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

console.log('\n全部通过 ✅');
