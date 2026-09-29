'use strict';
// 真·PK 页面（H5）服务端代理。
//
// ## 为什么要在 Node 里代理 H5，而不是直接用原版页面
//
// PK 的交互全在原版 H5 里（`leo.fbcontent.cn/bh5/leo-web-oral-pk/pk.html`）。
// 但把它原样嵌进来有**两个跨域死结**：
//
//  1. **API 请求跨域**：H5 的 axios `baseURL = https://xyks.yuanfudao.com/`，
//     从我们的页面发出去就是跨域 → 浏览器 CORS 直接拦掉。而正确请求还必须
//     带 `sign` + 风控头（`x-shepherd-did` / `leo-client-trace-id` /
//     `default-namespace-sw8`）+ `_productId=631&_appId=6` —— 这些是
//     [leo.buildUrl] / [leo.riskHeaders] 的活，H5 自己不会加。
//
//  2. **无法注入 hook**：跨域 iframe 的 contentDocument 取不到，没法在
//     H5 启动前改写它的请求层。
//
// 解法：**把 H5 整套（HTML + 它引用的资产）都代理到本机**，让 H5 与我们的
// 页面**同源**。同源之后两件事都成立了：
//  - 注入一段 `XMLHttpRequest` hook（见 [H5_INJECT]），把发往
//    `xyks` / `xyst` 的请求**改写到本机 `/api/pk/h5/api`**；
//  - Node 侧拿到改写后的请求，复用 [leo] 的签名/风控头/公共参数，用**该账号的
//    cookie** 发真请求，再把响应（含 Set-Cookie 吸收）回给 H5。
//
// ## 资产来源与缓存
//
// 资产从 CDN（`leo.fbcontent.cn`）按需拉取并**内存缓存**，所以 H5 版本升级
// 会自动跟随上游（我们只改写 HTML 里的 URL，不改写资产内容）。
//
// 资产 URL 形如 `https://leo.fbcontent.cn/bh5/leo-web-oral-pk/assets/xxx.js`，
// 本机路径统一为 `/pk-h5/assets/xxx.js`；其它 CDN 目录（`leo-common-bundle`）
// 走 `/pk-h5/<相对路径>`。

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const { config, PK } = require('./config');
const leo = require('./leo');
const { request } = require('./http');

/** H5 的 CDN 主机（资产与页面都在这里）。 */
const CDN_HOST = 'https://leo.fbcontent.cn';
/** PK H5 在 CDN 上的根目录。 */
const H5_BASE_PATH = '/bh5/leo-web-oral-pk';
/** 我方同源前缀 —— HTML 里所有 CDN URL 都会被改写成它。 */
const LOCAL_PREFIX = '/pk-h5';

/**
 * 允许被代理的 API host。
 *
 * ## 为什么是这几个（2026-09-29 由浏览器诊断实测得出）
 *
 *  - `xyks` —— 主域（PK：`/leo-game-pk/*`）
 *  - `xyst` —— solar 域（banner `/solar-activity/*`、配置中心）
 *  - `ape-api` —— 账号域（登录相关）
 *  - `oapi` —— 埋点/配置（`/orion-hubble-config/*`）
 *  - `ytk` —— **登录态查询**（`/accounts/api/current`）。
 *    这条最初漏了，导致 H5 判不出登录态 → 点 PK 没反应。
 *
 * 不在名单里的 host 会被 400 拒绝（见 [proxyApi]）。
 */
const API_HOSTS = [
  'xyks.yuanfudao.com',
  'xyst.yuanfudao.com',
  'ape-api.yuanfudao.com',
  'oapi.yuanfudao.com',
  'ytk.yuanfudao.com',
];

/* ------------------------------ 资产缓存 ------------------------------ */

/** url → { body:Buffer, contentType:string, at:number } */
const assetCache = new Map();
const ASSET_TTL_MS = 30 * 60 * 1000;

/** 拉取 CDN 资产（带缓存）。失败返回 null。 */
function fetchAsset(url) {
  const hit = assetCache.get(url);
  if (hit && Date.now() - hit.at < ASSET_TTL_MS) return Promise.resolve(hit);

  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      {
        host: u.host,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
        timeout: 20000,
      },
      (res) => {
        // 跟随一次重定向（CDN 偶发 302）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchAsset(new URL(res.headers.location, url).toString()));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const item = {
            body,
            contentType: normalizeContentType(res.headers['content-type'], u.pathname),
            at: Date.now(),
          };
          assetCache.set(url, item);
          resolve(item);
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** 按扩展名兜底推断 Content-Type（CDN 有时不给）。 */
function normalizeContentType(ct, pathname) {
  if (ct && ct !== 'application/octet-stream') return String(ct).split(';')[0];
  const ext = String(pathname).split('.').pop().toLowerCase();
  const map = {
    js: 'application/javascript',
    mjs: 'application/javascript',
    css: 'text/css',
    html: 'text/html',
    json: 'application/json',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
  };
  return map[ext] || 'application/octet-stream';
}

/* ------------------------------ HTML 改写 ------------------------------ */

/**
 * 要在 H5 之前注入的 hook 脚本。
 *
 * ## 它做什么
 *
 * H5 用 axios（基于 XMLHttpRequest）。这里在**所有脚本执行之前**包一层 XHR：
 *   - 只要请求的绝对/相对地址落在 `xyks.yuanfudao.com` / `xyst.yuanfudao.com` /
 *     `ape-api.yuanfudao.com`，就把 host 换成**本机同源**的 `/api/pk/h5/api`；
 *   - 原始目标 host 放进 `X-PK-Target` 头，Node 侧据此还原真实 URL；
 *   - `withCredentials` 打开时 cookie 同源自动带（我们自己就是同源）。
 *
 * 于是 H5 完全无感：它以为在发跨域请求，实际打到了本机代理，由 Node 补上
 * sign / 风控头 / 公共参数后转发。
 *
 * ## 为什么包 XHR 而不是 fetch
 *
 * H5 的 axios 适配器用的是 `XMLHttpRequest`（见 request-legacy 里的
 * `"adapter"` 函数体），不是 fetch。包 fetch 无效。
 */
const H5_INJECT = `(function () {
  var TARGET_HOSTS = ['xyks.yuanfudao.com', 'xyst.yuanfudao.com', 'ape-api.yuanfudao.com', 'oapi.yuanfudao.com', 'ytk.yuanfudao.com'];
  var LOCAL = '/api/pk/h5/api';

  /* ---- 预置 H5 的 localStorage 标记：跳过「新手引导」遮罩 ---- */
  //
  // ## 为什么必须做（2026-09-29 由页面快照诊断确证）
  //
  // useHomeModel 首屏执行：
  //     w.value = !s.getItem('oral-pk-guide')     // showGuide = 取反
  // 而 StorageUtil 实际读写的是 localStorage 的 __local_<key>（Base64 编码值）。
  //
  // 首次打开时该键不存在 → showGuide = true → **弹出一层全屏新手引导浮层**，
  // 把「开始PK / PK榜 / 好友挑战」全盖住 → 用户点击全部落在遮罩上 → 「点了没反应」。
  //
  // 快照诊断的原始证据（diag snapshot）：
  //     guide: "dHJ1ZQ=="            ← Base64("true")，即引导标记为空 / 放行
  //     overlays: ["pk 364x471", "content 364x471", ...]   ← 全屏层压在按钮上
  //     clickable: ["开始PK [pk-btn]", "PK榜 [rank]", ...]  ← 按钮本身是存在的
  //
  // 这里在 H5 脚本执行前把标记写进去（值按 StorageUtil 的格式做 Base64），
  // 于是 showGuide = false，浮层不弹，按钮可点。
  (function presetStorage() {
    try {
      var M = window.__PK_STORAGE_PRESET || {};
      Object.keys(M).forEach(function (k) {
        var name = '__local_' + k;
        var val = window.btoa ? window.btoa(M[k]) : M[k];
        window.localStorage.setItem(name, val);
      });
      diag('storage-preset', { keys: Object.keys(M) });
    } catch (e) { diag('storage-preset-err', { msg: String(e && e.message) }); }
  })();

  /* ---- 最小 Buffer polyfill（关键，2026-09-30）----
   *
   * H5 自己的**回调解析器**是 Node 风格写法：
   *     pt = t => new Buffer(t, 'base64').toString()
   * 真机 WebView 里有 Buffer polyfill，浏览器里**没有** →
   *     bridge-reply-err: "Buffer is not defined"
   * → 桥回调直接抛错 → H5 侧 Promise 永远不 resolve → 下级页面完全哑掉
   *   （日志里 getWebViewInfo 的回调就报这个错）。
   *
   * 这里只实现 H5 实际用到的部分：base64 解码 + toString()。
   * 只在全局缺失时定义，不覆盖 H5 自己可能加载的 polyfill。
   */
  (function installBuffer() {
    if (typeof window.Buffer !== 'undefined') { diag('buffer-ready', { existed: true }); return; }
    function mk(bytes) {
      var u8 = new Uint8Array(bytes);
      u8.toString = function (enc) {
        if (enc === 'base64') {
          var s = '';
          for (var j = 0; j < this.length; j++) s += String.fromCharCode(this[j]);
          return btoa(s);
        }
        try { return new TextDecoder('utf-8').decode(this); }
        catch (e) { return String.fromCharCode.apply(null, this); }
      };
      return u8;
    }
    function Buf(data, enc) {
      if (typeof data === 'string') {
        var bin = data;
        if (enc === 'base64' || enc === 'base64url') {
          var t = data.replace(/-/g, '+').replace(/_/g, '/');
          try { bin = atob(t); } catch (e) { bin = ''; }
        }
        var arr = [];
        for (var i = 0; i < bin.length; i++) arr.push(bin.charCodeAt(i) & 0xff);
        return mk(arr);
      }
      if (data && data.length != null) {
        var a2 = [];
        for (var k = 0; k < data.length; k++) a2.push(data[k] & 0xff);
        return mk(a2);
      }
      return mk([]);
    }
    Buf.from = function (d, e) { return Buf(d, e); };
    Buf.isBuffer = function () { return false; };
    Buf.byteLength = function (s) { return String(s).length; };
    window.Buffer = Buf;
    diag('buffer-ready', { existed: false });
  })();

  /* ---- 点击链路诊断：定位「点了有反馈但不跳转」到底断在哪一环 ---- */
  //
  // 2026-09-29：用户报「点按钮有反馈但不跳转」。已知 API 全 200、桥已挂载，
  // 但日志里**没有 openWebView / schema-other** → 断点在「点击 → 桥调用」之间。
  //
  // 这里在 document 上用**捕获阶段**监听全部 click（这样能先于 Vue 的处理跑），
  // 把命中的元素文案/class 回传；同时监听 hashchange（H5 是 SPA，跳转必然是 hash）。
  (function installClickDiag() {
    try {
      document.addEventListener('click', function (ev) {
        try {
          var el = ev.target;
          var chain = [];
          for (var i = 0; el && i < 5; i++, el = el.parentElement) {
            chain.push((el.tagName || '?') + '.' + (el.className || ''));
          }
          diag('click', {
            x: ev.clientX, y: ev.clientY,
            chain: chain.join(' < '),
            text: (ev.target && ev.target.textContent || '').slice(0, 40)
          });
        } catch (e) {}
      }, true);

      window.addEventListener('hashchange', function () {
        diag('hash', { hash: location.hash });
      });
    } catch (e) { diag('click-diag-err', { msg: String(e && e.message) }); }
  })();

  /* ---- 诊断上报：把页面里的异常与请求结果回传本机，便于无头排查 ---- */
  function diag(kind, data) {
    try {
      var payload = JSON.stringify({
        kind: kind,
        at: Date.now(),
        url: String(location.href),
        data: data,
      });
      // 用 sendBeacon/同步 XHR，避免页面跳转丢日志
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/pk/h5/diag?leoAccountId=' + (window.__PK_LEO_ID || ''), payload);
      } else {
        var x = new XMLHttpRequest();
        x.open('POST', '/api/pk/h5/diag?leoAccountId=' + (window.__PK_LEO_ID || ''), true);
        x.setRequestHeader('Content-Type', 'application/json');
        x.send(payload);
      }
    } catch (e) { /* 诊断本身不能影响页面 */ }
  }

  window.__pkDiag = diag;
  window.addEventListener('error', function (ev) {
    diag('error', {
      message: ev.message,
      source: ev.filename,
      line: ev.lineno,
      col: ev.colno,
      stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 1200) : null,
    });
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    diag('rejection', {
      message: r && r.message ? r.message : String(r),
      stack: r && r.stack ? String(r.stack).slice(0, 1200) : null,
    });
  });

  /* ==================== 原生桥模拟（关键！） ====================
   *
   * ## 为什么必须有这一段（2026-09-29「点 PK 没反应」的真因）
   *
   * PK H5 的**所有跳转**都不是页面内跳转，而是让原生开新 WebView：
   *
   *   useNavigation-legacy.js:
   *     gotoPkExercisePage / gotoSchoolSeasonMatchPage / gotoPkResultPage …
   *     -> n({ schemas: ['native://openWebView?url=...&keepScreenOn=true...'] })
   *
   * 这个 n 就是桥调用器（index-legacy.CHYoHfC0.js 里的 Lt），它的检测链：
   *
   *   const St = window;
   *   const g = (module ? 首字母大写(module) : '') + 'WebView';  // common -> CommonWebView
   *   if (St[g] && St[g][method])  -> St[g][method](json)         // App 里走这条
   *   else if (St.LeoWebView && St.LeoWebView.callNative) -> callNative(...)
   *   else -> 用隐藏 iframe 发 async:<module>_<method>:<json>    // 浏览器落到这里，无人接收
   *
   * 浏览器里 CommonWebView / LeoWebView 都不存在 -> 走 iframe 兜底 -> 没有原生
   * 去处理 -> **点了完全没反应**。
   *
   * 所以这里把桥补上，并把 native://openWebView 转成**真实跳转**：
   * H5 的每张页面都是独立 html（exercise.html / result.html / …），
   * 所以「开新 WebView」在本机等价于**iframe 内导航到该 url**。
   */
  /* ==================== 原生桥模拟（关键） ==================== */
  (function installBridge() {
    /* ---- H5 桥协议（逐行读 index-legacy.CHYoHfC0.js 得出，2026-09-29）----
     *
     * 调用（两条路径，payload 都是 base64）：
     *   A) window.CommonWebView.<method>(payloadB64)
     *   B) window.LeoWebView.callNative(payloadB64)      payload = {method:'common_xxx', params:{...}}
     *
     *   payload 解开后形如：
     *     { arguments: [ { trigger: 'getWebViewInfo_<ts>_<n>', ...业务参数 } ],
     *       callback:  '<method>_callback_<ts>_<n>' }
     *
     *   —— H5 传 trigger 时**不会**注册 callback（源码里 d = !(i||a) && u），
     *      所以必须用 trigger 当回调方法名。
     *
     * 回调（关键，之前就是这里写错了）：
     *     window[<trigger 或 callback>]( base64( JSON.stringify([err, ...data]) ) )
     *     err === null 表示成功。
     *
     *   源码依据：
     *     Nt = window
     *     Nt[t] = function (t) { e.apply(null, t ? JSON.parse(pt(t)) : [null]) }
     *     pt = t => new Buffer(t, 'base64').toString()
     *
     *   ★ 旧实现直接 cb(JSON.stringify(out)) —— 既没走 window[trigger]、
     *     也不是 base64，所以 Promise 永不 resolve → 点击静默无反应。
     */
    function b64decode(s) {
      var t = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
      try { return decodeURIComponent(escape(atob(t))); }
      catch (e) { try { return atob(t); } catch (e2) { return ''; } }
    }
    function b64encode(s) {
      try { return btoa(unescape(encodeURIComponent(String(s)))); } catch (e) { return ''; }
    }

    /** 解析 payload，取出业务参数与回调方法名。 */
    function parsePayload(raw) {
      var obj = null;
      if (typeof raw === 'string') {
        var txt = b64decode(raw);
        try { obj = JSON.parse(txt); } catch (e) { obj = null; }
        if (!obj) { try { obj = JSON.parse(raw); } catch (e2) { obj = null; } }  // 兼容裸 JSON
      } else if (raw && typeof raw === 'object') {
        obj = raw;
      }
      if (!obj) return { args: {}, cbName: null, rawObj: null };
      var h = (obj.arguments && obj.arguments[0]) || obj.params || {};
      var cb = h.trigger || obj.callback || (typeof obj.callback === 'string' ? obj.callback : null);
      if (typeof cb !== 'string' || !cb) cb = null;
      return { args: h, cbName: cb, rawObj: obj };
    }

    /** 把结果按 H5 的协议回给页面：window[cbName](base64([err, ...data]))。 */
    function reply(p, out) {
      if (!p.cbName) return;
      var s = b64encode(JSON.stringify(out));
      var f = window[p.cbName];
      if (typeof f === 'function') {
        try { f(s); diag('bridge-reply', { cb: p.cbName, out: JSON.stringify(out).slice(0, 160) }); }
        catch (e) { diag('bridge-reply-err', { cb: p.cbName, msg: String(e && e.message) }); }
      } else {
        diag('bridge-reply-miss', { cb: p.cbName });
      }
    }

    /** 处理 openSchema：从 schemas 里挑第一个能认的。 */
    function handleOpenSchema(args) {
      var list = (args && args.schemas) || [];
      for (var i = 0; i < list.length; i++) {
        var s = String(list[i] || '');
        // 注意：本段代码整体位于 Node 的模板字符串里，所以**不能用正则字面量**
        // （斜杠与反斜杠都会被外层处理）。改用字符串拆分，零转义负担。
        if (s.indexOf('native://openWebView?') === 0) {
          var q = s.slice('native://openWebView?'.length);
          var target = '';
          var parts = q.split('&');
          for (var j = 0; j < parts.length; j++) {
            if (parts[j].indexOf('url=') === 0) {
              target = decodeURIComponent(parts[j].slice(4));
              break;
            }
          }
          if (target) {
            var local = toLocalH5(target);
            diag('openWebView', { url: target.slice(0, 300), local: local.slice(0, 300) });
            // 本机把「开新 WebView」实现为 iframe 内导航（H5 每页都是独立 html）
            location.href = local;
            return 'OK';
          }
        }
        if (s.indexOf('native://') === 0) {
          diag('schema-other', { schema: s.slice(0, 200) });
          return 'OK';   // 其它原生 schema（closeWebView 等）当作已处理
        }
      }
      return 'OK';
    }

    /** 把任意外部 H5 地址折成本机同源地址（否则下级页面没有 hook 与桥）。
     *
     *  ★ 2026-09-30：这是「进入下级页面后没反应」的根因。
     *    H5 的跳转目标是 https://xyks.yuanfudao.com/bh5/leo-web-oral-pk/exercise.html
     *    —— 直接跳过去就脱离了本机代理，那边没有注入 → 整页哑掉。
     *
     *  规则（与 rewriteHtml 的同源化保持一致）：
     *    <任意源>/bh5/<目录>/<页面>            -> /pk-h5-cdn/<目录>/<页面>
     *    https://leo.fbcontent.cn/bh5/leo-web-oral-pk/<x> -> /pk-h5/<x>
     *    同源地址（已是本机）                    -> 原样
     *    data:/blob:/javascript:                -> 原样
     */
    function toLocalH5(url) {
      var u = String(url || '');
      if (!u) return u;
      var low = u.toLowerCase();
      if (low.indexOf('data:') === 0 || low.indexOf('blob:') === 0 ||
          low.indexOf('javascript:') === 0) return u;
      // 已经是本机同源
      if (u.indexOf(location.origin) === 0) return u;

      var BHP = '/bh5/';
      var i = u.indexOf(BHP);
      if (i < 0) return u;                       // 不是 bh5 资源，交给浏览器原样处理
      var rest = u.slice(i + BHP.length);        // 例如 leo-web-oral-pk/exercise.html?x=1
      var head = u.slice(0, i);                  // 主机部分

      // CDN 主目录走更短的 /pk-h5/ 前缀（与 HTML 改写保持一致）
      var CDN_ORAL = 'leo.fbcontent.cn' + BHP + 'leo-web-oral-pk/';
      var k = u.indexOf(CDN_ORAL);
      if (k >= 0) return location.origin + '/pk-h5/' + u.slice(k + CDN_ORAL.length);

      return location.origin + '/pk-h5-cdn/' + rest;
    }

    var HANDLERS = {
      openSchema: handleOpenSchema,
      // H5 的跳转既可能发 openSchema（schemas 数组），也可能直接发 openWebView。
      // 两条都接住，避免漏一种写法。
      openWebView: function (args) { return handleOpenSchema({ schemas: ['native://openWebView?' + (args && args.url ? 'url=' + encodeURIComponent(args.url) : '')] }); },
      closeWebView: function () { history.back(); return 'OK'; },
      getWebViewInfo: function () { return { version: BRIDGE_VERSION, platform: 'android' }; },
      setTitle: function () { return 'OK'; },
      toast: function () { return 'OK'; },
      loading: function () { return 'OK'; },
      setOnVisibilityChange: function () { return 'OK'; },
      jsLoadComplete: function () { return 'OK'; },
      getImmerseStatusBarHeight: function () { return 0; },
      getDeviceInfo: function () { return { platform: 'android', appVersion: BRIDGE_VERSION }; },
      // H5 头像 / 胜场 / 昵称的**首选来源**就是这里。
      // 不实现的话 H5 只能等服务端接口兜底 —— 表现就是
      // 「头像要切换年级后才显示、胜场显示 0」。数据由 Node 侧注入 window.__PK_USER。
      getUserInfo: function () { return window.__PK_USER || {}; },
      login: function () { return 'OK'; },
      // octopus 埋点 SDK 的配置读取。
      // ★ 键名必须是 method 本身：日志实测 H5 调的是 module=leo / method=getOrionConfig
      //   （payload.method = "leo_getOrionConfig"，由 callNative 拆成 module + method）。
      //   之前误写成 leo_getOrionConfig，导致 18 条 bridge-miss。
      getOrionConfig: function () { return {}; },
      leo_getOrionConfig: function () { return {}; },
      leoGetOrionConfig: function () { return {}; },
    };

    /** 缺省处理器：不认识的桥方法统一回「不支持」，并按协议回 trigger。
     *  —— 关键是**一定要回调**，否则 H5 侧 Promise 永久挂起，整条链路卡死。 */
    var MSG_METHOD_NOT_SUPPORT = 'METHOD_NOT_SUPPORT';

    /** 统一入口：按 method 分派，并按 H5 协议回调。 */
    function dispatch(module, method, raw) {
      var p = parsePayload(raw);
      // ★ 每个桥调用都回传 —— 点击链路的「最后一米」就是这里。
      diag('bridge-call', { module: module, method: method, cb: p.cbName, args: JSON.stringify(p.args).slice(0, 240) });

      var fn = HANDLERS[method];
      var out;
      if (!fn) {
        diag('bridge-miss', { module: module, method: method });
        out = [MSG_METHOD_NOT_SUPPORT];
      } else {
        // 业务参数 = arguments[0]（去掉 trigger/shareTrigger/callback 这些控制字段）
        var a = {};
        Object.keys(p.args || {}).forEach(function (k) {
          if (k !== 'trigger' && k !== 'shareTrigger' && k !== 'callback') a[k] = p.args[k];
        });
        try { out = [null, fn(a, p)]; }
        catch (e) { out = ['CALL_FAILED', String(e && e.message)]; }
      }
      reply(p, out);
      return true;
    }

    /** 造一个「方法名 → 处理器」的桥对象，对齐 H5 的查找方式。
     *
     *  H5 的 Lt 会先试 window[首字母大写(module)+'WebView'][method](payload)，
     *  再试 window.LeoWebView.callNative(payload)；两种入参都只有**一个** base64 串。
     */
    function makeBridge() {
      function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
      function moduleOf(payload) {
        var p = parsePayload(payload);
        var m = (p.rawObj && p.rawObj.method) || '';
        var i = m.indexOf('_');
        return i > 0 ? m.slice(0, i) : '';
      }
      var b = {
        // 路径 B：payload = { method: 'common_openWebView', params: {...} }
        callNative: function (payload) {
          var p = parsePayload(payload);
          var m = (p.rawObj && p.rawObj.method) || '';
          var i = m.indexOf('_');
          var mod = i > 0 ? m.slice(0, i) : '';
          var met = i > 0 ? m.slice(i + 1) : m;
          return dispatch(mod, met, payload);
        },
      };
      // 路径 A：window.CommonWebView[method](payload) —— method 名即 key
      Object.keys(HANDLERS).forEach(function (m) {
        b[m] = function (payload) { return dispatch(moduleOf(payload) || 'common', m, payload); };
      });
      return b;
    }

    // ★ getWebViewInfo 的版本必须过 H5 的版本下限（源码 X(l, n) < 0 则判不支持）。
    //   H5 取的 exceptedVersion（Gt）来自 UA 里的 App 版本；我们 UA 没后缀，
    //   所以给一个足够高的值即可。
    var BRIDGE_VERSION = '9.9.9';

    var bridge = makeBridge();
    // 名字都挂上：H5 按 module 前缀选对象名（common→CommonWebView / leo→LeoWebView …）
    ['WebView', 'CommonWebView', 'LeoWebView', 'LeoSecureWebView', 'SolarWebViewV2',
     'CommonWebview', 'LeoWebview'].forEach(function (name) {
      if (!window[name]) window[name] = bridge;
    });
    diag('bridge-ready', { names: Object.keys(window).filter(function (k) { return /Web[vV]iew$/.test(k); }) });
  })();

  function pickHost(url) {
    var low = String(url).toLowerCase();
    for (var i = 0; i < TARGET_HOSTS.length; i++) {
      if (low.indexOf(TARGET_HOSTS[i]) >= 0) return TARGET_HOSTS[i];
    }
    return null;
  }

  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;
  var _setHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    var rest = Array.prototype.slice.call(arguments, 2);
    this.__pkMethod = method;
    var host = pickHost(url);
    if (host) {
      try {
        var abs = new URL(String(url), location.href);
        this.__pkTarget = host + abs.pathname + abs.search;
        var leo = window.__PK_LEO_ID ? '&leoAccountId=' + encodeURIComponent(window.__PK_LEO_ID) : '';
        url = LOCAL + '?__t=' + encodeURIComponent(host) + leo;
      } catch (e) { /* 解析失败就原样放行 */ }
    } else if (String(url).indexOf('/api/pk/h5/') < 0 && String(url).indexOf('fbcontent') < 0) {
      // 记录了「没被代理、也不是自身诊断」的请求，便于发现漏掉的域
      diag('xhr-other', { method: method, url: String(url).slice(0, 300) });
    }
    return _open.apply(this, [method, url].concat(rest));
  };

  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      this.__pkHeaders = this.__pkHeaders || {};
      this.__pkHeaders[k] = v;
    } catch (e) { /* ignore */ }
    return _setHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var self = this;
    try {
      if (self.__pkTarget) {
        _setHeader.call(self, 'X-PK-Path', self.__pkTarget);
        _setHeader.call(self, 'X-PK-Headers', JSON.stringify(self.__pkHeaders || {}));
      }
    } catch (e) { /* ignore */ }

    // 记录每个被代理请求的结果 —— 「点击没反应」时这是最直接的证据
    if (self.__pkTarget && !self.__pkDiagBound) {
      self.__pkDiagBound = true;
      self.addEventListener('loadend', function () {
        var body = '';
        try { body = String(self.responseText || '').slice(0, 400); } catch (e) { body = '(读不到)'; }
        diag('api-result', {
          method: self.__pkMethod,
          target: self.__pkTarget,
          status: self.status,
          body: body,
        });
      });
    }
    return _send.apply(self, arguments);
  };

  // fetch 也包一层（H5 主要用 XHR，但保险）
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var host = pickHost(url);
      if (host) {
        try {
          var abs = new URL(String(url), location.href);
          var leo = window.__PK_LEO_ID ? '&leoAccountId=' + encodeURIComponent(window.__PK_LEO_ID) : '';
          var newUrl = LOCAL + '?__t=' + encodeURIComponent(host) + leo;
          init = init || {};
          init.headers = Object.assign({}, init.headers || {}, {
            'X-PK-Path': host + abs.pathname + abs.search,
            'X-PK-Headers': JSON.stringify(init.headers || {}),
          });
          return _fetch.call(this, newUrl, init).then(function (r) {
            r.clone().text().then(function (t) { diag('fetch-result', { target: host + abs.pathname, status: r.status, body: String(t).slice(0, 400) }); }).catch(function () {});
            return r;
          });
        } catch (e) { /* fallthrough */ }
      }
      return _fetch.apply(this, arguments);
    };
  }

  diag('hook-ready', { ver: 3, leoId: window.__PK_LEO_ID || null, ua: navigator.userAgent.slice(0, 200) });

  /* ---- 页面快照诊断：把「屏幕上到底有什么」回传，用于无头定位点击无反应 ---- */
  (function snapshot() {
    function dump(tag) {
      try {
        var info = {
          tag: tag,
          href: location.href.slice(-60),
          // 关键 storage（H5 用它判断是否要弹「新手引导」遮罩）
          guide: (function () {
            try { return localStorage.getItem('__local_oral-pk-guide'); } catch (e) { return '(不可读)'; }
          })(),
          title: document.title,
          // 屏幕上所有带「遮罩/引导」语义的元素尺寸（盖住按钮的元凶）
          overlays: [],
          // 可见按钮/可点元素的文案（用户说「按钮点了没反应」，先确认有哪些）
          clickable: [],
        };
        var all = document.querySelectorAll('body *');
        for (var i = 0; i < all.length && i < 900; i++) {
          var el = all[i];
          var cls = String(el.className || '');
          var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
          var vis = cs && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity || 1) > 0.01;
          if (!vis) continue;
          var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          if (!r) continue;
          // 覆盖全屏的大块（可能是遮罩）
          if (r.width >= window.innerWidth * 0.8 && r.height >= window.innerHeight * 0.6 && info.overlays.length < 8) {
            info.overlays.push(cls.slice(0, 70) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' z=' + (cs.zIndex || 'auto'));
          }
          var txt = (el.innerText || '').trim();
          if (txt && txt.length > 0 && txt.length < 14 && r.width > 10 && r.height > 10 && info.clickable.length < 30) {
            var looksClickable = (cs && (cs.cursor === 'pointer' || cs.position === 'fixed')) || /btn|button|tab|pk|rank|invite|start/i.test(cls);
            if (looksClickable) info.clickable.push(txt + ' [' + cls.slice(0, 40) + ']');
          }
        }
        diag('snapshot', info);
      } catch (e) { diag('snapshot-err', { msg: String(e && e.message) }); }
    }
    // 首屏 + 稍后各抓一次（H5 是异步渲染）
    setTimeout(function () { dump('t2.5s'); }, 2500);
    setTimeout(function () { dump('t7s'); }, 7000);
  })();

  window.__pkH5Hook = { version: 2, local: LOCAL, hosts: TARGET_HOSTS };
})();`;

/**
 * 改写 H5 的 HTML：把 CDN 的绝对 URL 全部换成本机同源路径，并注入 hook。
 *
 * 注入必须放在 `<head>` 的**第一个** script 之前 —— H5 的 request 模块在
 * 模块加载时就定义好了 axios，晚注入就拦不到。
 *
 * @param {Buffer} html 原始 HTML
 * @returns {Buffer} 改写后的 HTML
 */
function rewriteHtml(html, opts) {
  let s = html.toString('utf8');
  const leoId = opts && opts.leoAccountId != null ? String(opts.leoAccountId) : '';

  // 0) 把 leoAccountId 与「跳过新手引导」的存储标记提前注入：
  //    hook 脚本要用它们，且必须在 H5 主脚本**之前**执行。
  //
  //    oral-pk-guide 见 useHomeModel：showGuide = !getItem('oral-pk-guide')。
  //    预置成 'true' 后：getItem 返回 'true' → showGuide=false → 浮层不弹。
  //    （值会被 StorageUtil 做 Base64 存储，所以这里给**明文** 'true'，
  //      由注入脚本的 presetStorage 负责编码。）
  const pre = [
    leoId ? '<script>window.__PK_LEO_ID=' + JSON.stringify(leoId) + ';</script>' : '',
    '<script>window.__PK_STORAGE_PRESET={"oral-pk-guide":"true"};</script>',
  ].join('');

  // 1) 把 CDN 上的 H5 目录换成本机 /pk-h5 前缀
  //    例：https://leo.fbcontent.cn/bh5/leo-web-oral-pk/assets/x.js → /pk-h5/assets/x.js
  s = s.split(CDN_HOST + H5_BASE_PATH + '/').join(LOCAL_PREFIX + '/');
  //    H5 页面本身的引用（不带 assets），如 .../pages/xxx.html
  s = s.split(CDN_HOST + H5_BASE_PATH).join(LOCAL_PREFIX);
  // 2) 其余 CDN 目录（leo-common-bundle 等）→ /pk-h5-cdn/<path>
  s = s.split(CDN_HOST + '/bh5/').join(LOCAL_PREFIX + '-cdn/');
  s = s.split(CDN_HOST + '/').join(LOCAL_PREFIX + '-cdn/');

  // 2.5) ★ 其它源上的同构 H5（2026-09-30）
  //
  //  H5 的跳转目标不限于 CDN，还有业务域上的 H5 目录，例如：
  //    https://xyks.yuanfudao.com/bh5/leo-web-oral-pk/exercise.html
  //    https://xyks.yuanfudao.com/bh5/leo-web-study-group/motivation-honor-roll.html
  //  实测这些页面与 leo.fbcontent.cn/bh5/* **内容完全一致**（同一套构建产物）。
  //
  //  不做这一步的后果：点「开始PK」后跳到真实域名 → 那边没有我们的
  //  hook 与桥 → **下级页面完全哑掉**。
  //
  //  所以把所有 `<协议>://<任意主机>/bh5/<目录>/<页面>` 统一折成本机的
  //  /pk-h5-cdn/<目录>/<页面>（由 serve() 从 CDN 取同名文件）。
  //  `/bh5/` 是协议级路径，各业务域都只是同一个静态托管，故可互换。
  //
  //  注意：本段位于 Node 模板字符串之外（是普通 JS），可以用正则。
  s = s.replace(/https?:\/\/[A-Za-z0-9.-]+\/bh5\//g, LOCAL_PREFIX + '-cdn/');

  // 3) 注入 hook：插在 <head> 后、任何 script 之前
  const inject = pre + '<script>' + H5_INJECT + '</script>';
  const headIdx = s.indexOf('<head>');
  if (headIdx >= 0) {
    s = s.slice(0, headIdx + 6) + inject + s.slice(headIdx + 6);
  } else {
    s = inject + s; // 没有 head 就放最前
  }

  return Buffer.from(s, 'utf8');
}

/* ------------------------------ 入口处理 ------------------------------ */

/**
 * 处理 `/pk-h5/*` 与 `/pk-h5-cdn/*`：把 CDN 资产（含 HTML）透传给浏览器。
 *
 * HTML 会被改写（URL 同源化 + 注入 hook）；其余资产原样透传。
 *
 * ## 为什么 `-cdn` 要支持**任意目录**（2026-09-30）
 *
 * PK 的跳转目标不止 `leo-web-oral-pk`，还有别的 H5 应用，例如：
 *     https://xyks.yuanfudao.com/bh5/leo-web-study-group/motivation-honor-roll.html
 * 这些页面同样需要「同源 + 注入 hook + 桥」，否则点过去就哑了。
 * 实测 `xyks.yuanfudao.com/bh5/*` 与 `leo.fbcontent.cn/bh5/*` 内容一致，
 * 所以统一从 CDN 取。
 *
 * @returns {Promise<boolean>} true = 已处理（响应已写）
 */
async function serve(req, res, u) {
  let cdnUrl = null;
  const path = u.pathname;

  if (path === '/pk-h5' || path === '/pk-h5/' || path === '/pk-h5/pk.html') {
    cdnUrl = CDN_HOST + H5_BASE_PATH + '/pk.html';
  } else if (path.startsWith(LOCAL_PREFIX + '/')) {
    // /pk-h5/assets/x.js → CDN 的 leo-web-oral-pk/assets/x.js
    cdnUrl = CDN_HOST + H5_BASE_PATH + path.slice(LOCAL_PREFIX.length);
  } else if (path.startsWith(LOCAL_PREFIX + '-cdn/')) {
    // /pk-h5-cdn/<任意目录>/x.js → CDN 的 bh5/<任意目录>/x.js
    cdnUrl = CDN_HOST + '/bh5/' + path.slice((LOCAL_PREFIX + '-cdn/').length);
  }

  if (!cdnUrl) return false;

  const asset = await fetchAsset(cdnUrl);
  if (!asset) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('H5 资源拉取失败：' + cdnUrl);
    return true;
  }

  let body = asset.body;
  let contentType = asset.contentType;
  if (contentType.indexOf('text/html') >= 0 || cdnUrl.endsWith('.html')) {
    body = rewriteHtml(body, { leoAccountId: u.searchParams.get('leoAccountId') });
    contentType = 'text/html';
  }

  res.writeHead(200, {
    'Content-Type': contentType + (contentType.indexOf('text/') === 0 || contentType.indexOf('javascript') >= 0 || contentType.indexOf('json') >= 0 ? '; charset=utf-8' : ''),
    'Content-Length': body.length,
    // HTML 不缓存（便于跟随上游升级）；资产短缓存
    'Cache-Control': cdnUrl.endsWith('.html') ? 'no-store' : 'public, max-age=600',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
  return true;
}

/* ------------------------------ API 代理 ------------------------------ */

/**
 * 处理 `/api/pk/h5/api?__t=<host>`：把 H5 的请求转发到真实主域。
 *
 * 关键点：
 *  1. **还原真实 URL**：H5 被 hook 改写后只剩 `?__t=host`，真实路径在
 *     `X-PK-Path` 头里（hook 写的）。
 *  2. **补公共参数与 sign**：用 [leo.buildUrl] 重新组装 —— 它会补
 *     `_productId` / `_appId` / `version` / `platform` 等，并按需加 `sign`。
 *     H5 自己已经带了 `_productId` 的话会**原样保留**（buildUrl 里业务参数
 *     优先级最高）。
 *  3. **风控头**：`leo-game-pk` 走 [leo.riskHeaders]；`xyst` 域（solar）也带上。
 *  4. **Cookie**：用**该小猿账号**的 jar（H5 里没有登录态，登录态在 Node）。
 *
 * @param {object} ctx { jar, rawBody }
 */
async function proxyApi(req, res, u, ctx) {
  const targetHost = u.searchParams.get('__t') || '';
  const rawPath = req.headers['x-pk-path'] || req.headers['X-PK-Path'] || '';
  if (!rawPath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message: '缺少 X-PK-Path（H5 hook 未生效？）' }));
    return;
  }

  // X-PK-Path 形如 `xyks.yuanfudao.com/leo-game-pk/android/math/pk/home?grade=2`
  const slash = rawPath.indexOf('/');
  const host = slash > 0 ? rawPath.slice(0, slash) : (targetHost || API_HOSTS[0]);
  const pathAndQuery = slash > 0 ? rawPath.slice(slash) : rawPath;

  if (API_HOSTS.indexOf(host) < 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message: '不允许的代理目标：' + host }));
    return;
  }

  const qi = pathAndQuery.indexOf('?');
  const pathOnly = qi >= 0 ? pathAndQuery.slice(0, qi) : pathAndQuery;
  const query = {};
  if (qi >= 0) {
    new URLSearchParams(pathAndQuery.slice(qi + 1)).forEach((v, k) => { query[k] = v; });
  }

  const method = req.method.toUpperCase();

  // H5 原标题（hook 收集的），挑几个需要透传的
  let h5Headers = {};
  try { h5Headers = JSON.parse(req.headers['x-pk-headers'] || '{}'); } catch (e) { /* ignore */ }
  const passContentType = h5Headers['Content-Type'] || h5Headers['content-type'] || 'application/json';

  const isHostLeo = host === 'xyks.yuanfudao.com';
  const isHostSolar = host === 'xyst.yuanfudao.com';

  // 组装真实 URL：xyks / xyst 都走 buildUrl（补公共参数 + sign）。
  //
  // ## 为什么 xyst 也要（2026-09-29 实测）
  //
  // `xyst.yuanfudao.com/solar-activity/*` 同样被 `solar-encoder` 保护 ——
  // 只带 H5 自己那套参数（无 sign）会 417 `No message available`；
  // 与主域同源，需要 sign + 主域公共参数。H5 自己不算 sign（那是原生
  // `LeoSecure.calculateSign` 的活），所以必须在代理侧补。
  let realUrl;
  if (isHostLeo || isHostSolar) {
    const isPk = pathOnly.indexOf('/leo-game-pk') === 0;
    // ★ 强制 PK 的 `_productId=631` / `_appId=6`（**覆盖** H5 传来的值）。
    //
    //   2026-09-29：H5 在**浏览器**里跑时 `isAppUA=false`（UA 不含
    //   `YuanSouTiKouSuan`，那是 WebView 才追加的后缀），于是它按
    //   `location.hostname` 分支算出 `_productId=131`（127.0.0.1 不匹配任何
    //   已知域 → 兜底 131），并把 131 拼进 URL 发出来。
    //
    //   而 PK 端点（`leo-game-pk`）在 `SolarAuthFilter` 上**硬要求 631 + _appId=6**
    //   —— 用 131 会被判为另一个产品线。`leo.buildUrl` 里业务参数优先级最高，
    //   不覆盖就会被 H5 的 131 冲掉。这里显式覆盖。
    if (isPk) {
      query._productId = '631';
      query._appId = '6';
    }
    // ★ 把 H5 传的 `version` 换成**主域协议版本**（3.140.1）。
    //
    //   2026-09-29 实测（xyst solar-activity）：
    //     version=3.141.1（H5 从 UA 取的 App 版本） → 417 No message available
    //     version=3.140.1（主域协议版本）          → 200 正常返回 banner
    //   与 pk-node 早先在练习/主域上踩到的是**同一个坑**：solar-encoder 认的是
    //   协议版本，不是 App 版本。H5 不知道这件事，所以必须在代理侧纠正。
    query.version = PK.exercise.version;
    realUrl = leo.buildUrl(pathOnly, query, {
      // PK 路由用 631 + _appId=6；其余（含 solar）走默认 611。
      // query 里已有 _productId 时 buildUrl 会保留它（业务参数优先）。
      productId: isPk ? '631' : undefined,
      appId: isPk ? '6' : undefined,
      // solar 域的 host 与主域不同，buildUrl 默认拼 leoBase（xyks），
      // 这里替换 host 后再返回。
    });
    if (isHostSolar) realUrl = realUrl.replace('https://' + config.leoHost, 'https://' + host);
  } else {
    const q = new URLSearchParams(query).toString();
    realUrl = 'https://' + host + pathOnly + (q ? '?' + q : '');
  }

  const headers = Object.assign(
    {},
    isHostLeo || isHostSolar ? leo.riskHeaders() : {},
    { 'Content-Type': passContentType },
  );

  let bodyBuf = null;
  if (method !== 'GET' && method !== 'HEAD') {
    bodyBuf = await readRaw(req, 8 * 1024 * 1024);
  }

  try {
    const r = await request({
      url: realUrl,
      method: method,
      jar: ctx.jar,
      body: bodyBuf && bodyBuf.length ? bodyBuf : undefined,
      headers: headers,
    });

    // 把响应原样回给 H5（H5 自己解析业务码）
    const outHeaders = {
      'Content-Type': (r.headers && r.headers['content-type']) || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    };
    const outBody = Buffer.from(r.text || '', 'utf8');
    outHeaders['Content-Length'] = outBody.length;
    res.writeHead(r.status, outHeaders);
    res.end(outBody);

    // 审计：把「H5 打了什么、真实 URL 是什么、结果如何」记下来，便于定位 417
    console.log('[pk-h5] ' + method + ' ' + host + pathOnly +
      ' → HTTP ' + r.status + (r.status !== 200 ? ' body=' + String(r.text || '').slice(0, 200) : ''));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, message: '代理失败：' + e.message }));
  }
}

/** 读取原始请求体。 */
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = {
  CDN_HOST,
  H5_BASE_PATH,
  LOCAL_PREFIX,
  API_HOSTS,
  H5_INJECT,
  rewriteHtml,
  serve,
  proxyApi,
};
