/**
 * 从服务端真实吐出的 hook 里抽出「桥处理器」，单测 feature flag 返回值。
 * 不依赖浏览器：用 vm 建沙箱跑真实代码。
 */
const fs = require('fs');
const vm = require('vm');
const http = require('http');

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let o = ''; r.on('data', (d) => o += d); r.on('end', () => res(o)); }).on('error', rej);
  });
}

(async () => {
  const port = process.env.PK_PORT || 8792;
  const html = await get(`http://127.0.0.1:${port}/pk-h5/pk.html?leoAccountId=6`);
  // 注入内容是多段内联 <script>（__PK_LEO_ID / __PK_STORAGE_PRESET / 主 hook），
  // 全部拼起来在同一个沙箱里跑，才能互相引用。
  const parts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const code = parts.join('\n;\n');
  if (!parts.length) { console.error('没找到内联 script'); process.exit(1); }
  console.log('内联 script 段数：', parts.length, '总长', code.length);

  const noop = () => {};
  const mkEl = () => ({ style: {}, appendChild: noop, setAttribute: noop, addEventListener: noop, getContext: () => ({ scale: noop }), textContent: '', children: { length: 0 } });
  const sandbox = {
    console: { log: noop, error: noop, warn: noop },
    setTimeout: () => 0, setInterval: () => 0, clearTimeout: noop, clearInterval: noop,
    JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, Error, RegExp,
    Uint8Array, ArrayBuffer, Blob: function () {}, TextDecoder, TextEncoder,
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    XMLHttpRequest: function () { this.open = noop; this.send = noop; this.setRequestHeader = noop; },
    document: { createElement: mkEl, body: { appendChild: noop }, getElementById: () => null,
      querySelectorAll: () => [], querySelector: () => null, addEventListener: noop, documentElement: mkEl() },
    location: { pathname: '/pk-h5/pk.html', href: '', origin: `http://127.0.0.1:${port}`, hostname: '127.0.0.1', search: '' },
    navigator: { userAgent: 'Mozilla/5.0 YuanSouTiKouSuan/3.141.1', sendBeacon: () => true },
    localStorage: { _s: {}, getItem(k) { return this._s[k] == null ? null : this._s[k]; },
      setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = noop;

  vm.createContext(sandbox);
  try { vm.runInContext(code, sandbox, { timeout: 5000 }); }
  catch (e) { console.error('运行期报错：', e.message.slice(0, 200)); process.exit(1); }

  if (!sandbox.__pkH5Hook) { console.error('hook 未执行（没有 __pkH5Hook）'); process.exit(1); }
  console.log('hook 已执行：', JSON.stringify(sandbox.__pkH5Hook));

  const T = (name, arg) => {
    const H = sandbox.__pkHandlers;
    if (!H) return 'NO_HANDLERS';
    const h = H[name];
    if (typeof h !== 'function') return { MISS: name };
    return h(arg || {});
  };
  const cases = [
    ['getFeatureConfig', { featureKey: 'leo.unlogin.pk' }, 'false'],
    ['getFeatureConfig', { featureKey: 'leoShowPreschool' }, 'false'],
    ['getFeatureConfig', { featureKey: 'leoOralPKExerciseUseMerge' }, 'false'],
    ['getOrionConfig', { orionKey: 'leo.fusion.honor.ranking.config' }, { content: { inUse: true } }],
    ['getOrionConfig', { orionKey: 'leo.oral.pk.schoolSeason.entry' }, { content: { enable: false } }],
    ['getFeatureConfig', { featureKey: '不存在的key' }, null],
  ];
  let bad = 0;
  for (const [fn, arg, want] of cases) {
    let got;
    try { got = T(fn, arg); } catch (e) { got = 'THROW:' + e.message; }
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) bad++;
    console.log((ok ? '  ok  ' : '  FAIL') + ` ${fn}(${JSON.stringify(arg)}) = ${JSON.stringify(got)}` + (ok ? '' : `  期望 ${JSON.stringify(want)}`));
  }
  console.log(bad === 0 ? '\n全部通过 ✅' : `\n${bad} 个失败 ❌`);
  process.exit(bad === 0 ? 0 : 1);
})();