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

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const zlib = require('node:zlib');
const keystream = require('./keystream');
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

/**
 * 是否允许代理该 host。
 *
 * ## 为什么要通配（2026-09-30）
 *
 * 起初用的是**硬编码白名单**（xyks/xyst/ape-api/oapi/ytk）。但原版 H5 的各
 * 子页面会打**不同**的业务域，实测遇到过的有：
 *
 *   - `leo-homework/*`      → PK 榜（daily-practice/rank/info）
 *   - `leo-activity/*`      → 道具 / 背包
 *   - `leo-alchemy-account/*` → 好友 / 头像挂件
 *   - `leo-star/*`          → 胜率 / 任务
 *   - `leo-reward/*`        → 积分兑换
 *
 * 漏一个域 → 那个页面的数据请求**根本不走代理**（既没带 sign/公共参数，
 * 也不会被记进诊断日志）→ 页面「渲染出来但内容空白」。
 *
 * 所以改成通配：只要是 `*.yuanfudao.com`（含 .biz 测试域）就允许。
 * 安全性：代理只转发到这些自有域，且 host 由**我们注入的 hook** 写入，
 * 页面脚本无法借它访问任意第三方。
 */
function isAllowedHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (API_HOSTS.indexOf(h) >= 0) return true;
  return /\.yuanfudao\.(com|biz)$/.test(h);
}

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
  /* 允许代理的 host 判定（与 Node 侧 isAllowedHost 保持一致）。
   *
   * 原先是硬编码白名单，会漏掉各子页面的业务域（leo-homework / leo-activity
   * / leo-alchemy-account / leo-star / leo-reward 等）→ 那些请求根本不走代理，
   * 页面「渲染出来但内容空白」（PK 榜就是典型）。改成通配 *.yuanfudao.com。
   */
  function pkIsAllowedHost(h) {
    var x = String(h || '').toLowerCase();
    if (!x) return false;
    if (TARGET_HOSTS.indexOf(x) >= 0) return true;
    return /\.yuanfudao\.(com|biz)$/.test(x);
  }
  var LOCAL = '/api/pk/h5/api';
  // 稳定的伪设备 id：同一会话内必须一致，否则 H5 会反复重渲染（表现是界面抖/闪）。
  var DEVICE_ID = 'pknode-' + Math.random().toString(36).slice(2, 10);

  /* ---- 伪装成小猿 App 的 WebView UA（2026-09-30）----
   *
   * H5 用 UA 判断「是不是在 App 里」，而这个判断决定了**大量入口是否渲染**：
   *
   *   Utils-legacy:
   *     ct = () => UA 含 "YuanSouTiKouSuan"
   *     st = () => UA 含 "YuanSouTi"
   *   pk-legacy（8 人 PK 按钮）:
   *     O = isLogin && (ct() || st())        // ← 不满足则整个按钮不渲染
   *   pk-legacy（巅峰赛入口）:
   *     D = isLogin && ct() && ...
   *   useHomeModel:
   *     v() = isAppUA → 影响大量 App-only 分支
   *
   * 真机 WebView 的 UA 末尾会追加 App 标识，例如：
   *     ... Safari/537.36 YuanSouTiKouSuan/3.141.1
   * 我们跑在普通浏览器里没有这个后缀 → 「8人PK」「巅峰赛」等入口全都不出现。
   *
   * 这里在 H5 脚本执行**之前**改写 navigator.userAgent（追加后缀）。
   * 只追加、不替换，保留原有 Android/Chrome 信息，避免其它 UA 检测失效。
   *
   * ⚠️ 副作用：productId 计算会从兜底 131 变成 611，但我们已在代理侧强制
   *    _productId=631（pk-node 的 PK 端点硬要求），所以不受影响。
   */
  (function patchUserAgent() {
    try {
      var SUFFIX = ' YuanSouTiKouSuan/3.141.1';
      var orig = navigator.userAgent || '';
      if (orig.indexOf('YuanSouTiKouSuan') >= 0) { diag('ua-patch', { skipped: true }); return; }
      var patched = orig + SUFFIX;
      var ok = false;
      try {
        Object.defineProperty(navigator, 'userAgent', {
          get: function () { return patched; },
          configurable: true,
        });
        ok = navigator.userAgent === patched;
      } catch (e) { ok = false; }
      if (!ok) { try { navigator.userAgent = patched; ok = true; } catch (e2) {} }
      diag('ua-patch', { ok: ok, tail: patched.slice(-46) });
    } catch (e) { diag('ua-patch-err', { msg: String(e && e.message) }); }
  })();

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
      var cb = h.trigger || (typeof obj.callback === 'string' ? obj.callback : null);
      if (typeof cb !== 'string' || !cb) cb = null;
      // 回执回调与 trigger 是**两个不同**的回调（见 reply / NO_TRIGGER_METHODS 的说明）。
      var rc = typeof obj.callback === 'string' ? obj.callback : null;
      return { args: h, cbName: cb, receiptName: rc, rawObj: obj };
    }

    /**
     * ★★ 不能回调 trigger 的桥方法（setter 语义）—— 2026-09-30 的关键真 bug。
     *
     * ## 为什么（排行榜「打开又自己退回」的根因）
     *
     * H5 的 trigger 字段有**两种语义**：
     *
     *  1. **查询类**（getUserInfo / getWebViewInfo / requestConfig …）
     *     trigger 是「回执回调」：页面注册 window[trigger]，
     *     我们必须 unshift 结果把 Promise resolve 掉。
     *
     *  2. **setter 类**（setLeftButton / setOnVisibilityChange / refreshStateView …）
     *     trigger 是**事件处理器**，页面把它**登记**进原生侧，
     *     等用户**真正按下**时才回调。我们若在登记时立刻回调，
     *     等于**替用户按下了这个键**！
     *
     * 实测证据（motivation-honor-roll 荣誉榜，2026-09-30）：
     *
     *     // 页面代码
     *     f = () => {
     *       m.postMessage({eventName:'exercise_motivation_back_pk', ...});
     *       s();                      // s() = closeWebView()
     *     };
     *     setLeftButton({ trigger: () => { f() } });   // 返回键处理器
     *
     *     // 我们的日志（间隔 2ms，页面加载 4ms 后）
     *     341994 setLeftButton    cb=setLeftButton_..._24
     *     341996 sendEventToNative exercise_motivation_back_pk   ← 「返回键被按下」
     *     341996 closeWebView      → 'OK'
     *
     * → 页面一打开就自己关闭，用户看到的就是「排行榜打开又退回 PK 主页」。
     *
     * 所以这些方法**只回复执、不动 trigger**。
     */
    var NO_TRIGGER_METHODS = {
      setLeftButton: 1,
      setOnVisibilityChange: 1,
      refreshStateView: 1,
      setForceBounceEnable: 1,
      observeTabChange: 1,
      ShowPracticeDialogIfNeeded: 1,
    };

    /** 把结果按 H5 的协议回给页面：window[cbName](base64([err, ...data]))。
     *
     *  - p.cbName 为空 → 无事可做（有些方法 H5 不传回调）。
     *  - p.skipTrigger 为真 → **只回复执**（obj.callback），
     *    绝不触碰 trigger（见 NO_TRIGGER_METHODS 的说明）。
     */
    function reply(p, out) {
      var s = b64encode(JSON.stringify(out));
      // ① 回执回调：H5 用 payload.callback 指定（有才回）
      if (p.receiptName && typeof window[p.receiptName] === 'function') {
        try { window[p.receiptName](s); } catch (e) { /* ignore */ }
      }
      // ② trigger 回调：setter 类方法**跳过**（否则等于替用户按键）
      if (p.skipTrigger || !p.cbName) return;
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
            var local = addLeoId(toLocalH5(target));
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

    /** 给同源地址补上 leoAccountId（下级页靠它找账号，缺了就 404「账号不存在」）。
     *
     *  ★ 2026-09-30：这是「下级页匹配不了」的根因。
     *    H5 自己拼的跳转 URL 只带业务参数：
     *      /bh5/leo-web-oral-pk/exercise.html?pointId=22&isFromInvite=undefined&jumpTime=...
     *    我们自己注入的 leoAccountId 只存在于**上一页**的 URL 上，跳转就丢了 → 下级页
     *    所有 API 都 404「账号不存在」（日志里 match/v2 重试了 380 次）。
     *
     *    所以跳转前把账号补回去（放在 ? 之后、# 之前，避免破坏 hash 路由）。
     */
    function addLeoId(u) {
      var id = window.__PK_LEO_ID || '';
      if (!id || !u) return u;
      if (u.indexOf('leoAccountId=') >= 0) return u;
      var hashIdx = u.indexOf('#');
      var hash = hashIdx >= 0 ? u.slice(hashIdx) : '';
      var base = hashIdx >= 0 ? u.slice(0, hashIdx) : u;
      var sep = base.indexOf('?') >= 0 ? '&' : '?';
      return base + sep + 'leoAccountId=' + encodeURIComponent(id) + hash;
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

    /** 把密文交给 Node 侧解密（浏览器里没有 keystream）。
     *
     * ★★ 2026-09-30：这是「PK 一直匹配中」的真正最后一层。
     *
     * H5 的响应拦截器（exercise-legacy 的 u / l 函数）对 arraybuffer 响应：
     *     r = btoa(String.fromCharCode.apply(null, new Uint8Array(resp)));
     *     l(r)  →  桥 LeoSecure.dataDecrypt({base64: r, trigger:(err, res) => {
     *                  resolve(JSON.parse(Base64.decode(res.result))) })}
     * 即：**H5 自己会解密**，只是解密要调原生桥。
     *
     * 所以桥必须实现 dataDecrypt：把密文 POST 给 /api/pk/h5/decrypt，
     * 拿回明文 JSON 的 base64，再按协议回调。
     */
    function nodeDecrypt(b64) {
      return new Promise(function (resolve) {
        try {
          var x = new XMLHttpRequest();
          x.open('POST', '/api/pk/h5/decrypt', true);
          x.setRequestHeader('Content-Type', 'application/json');
          x.onload = function () {
            var out = null;
            try { out = JSON.parse(x.responseText); } catch (e) { out = null; }
            resolve(out && out.ok ? out.result : null);
          };
          x.onerror = function () { resolve(null); };
          x.send(JSON.stringify({ base64: b64 }));
        } catch (e) { resolve(null); }
      });
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
      //
      // ★★ 2026-09-30：这里就是「isLogin 永远为 false → 无限刷新」的根因！
      //
      // H5 的登录态判定链（index-legacy.CHYoHfC0.js 的 r("i", ...)）：
      //     $t("getUserInfo", {V1:Gt, validParams:{params:{trigger:true}}})
      //     n = r[0]                 // ← 桥返回数组的第一个元素
      //     at("webviewLogin", n)    // ← 写进 store
      //     ...
      //     return n
      // 而 useHomeModel 的 isLogin 就是 setter v = e.i（即这个函数）的执行结果。
      // 返回 {} 时 isLogin 恒为 false。
      //
      // 后果（pk-legacy 里三个入口都有这段）：
      //     if (!isLogin && !unloginPkEnable) {
      //       await dialog({ loginTitle: "登录后开始PK" });
      //       window.location.reload();      // ← 死循环，页面一直刷新
      //       return;
      //     }
      //
      // 所以必须返回**真实的** userId（非 0 即视为已登录）。
      // 数据由 Node 侧注入 window.__PK_USER（见 server.js 的 /pk-h5 分支）。
      getUserInfo: function () { return window.__PK_USER || {}; },

      /* ★★ dataDecrypt（LeoSecure）—— 2026-09-30：「PK 一直匹配中」的最后一层
       *
       * H5 的响应拦截器（exercise-legacy 的 u / l）对 arraybuffer 响应会：
       *   btoa(Uint8Array(resp)) → 调桥 dataDecrypt({base64, trigger})
       *     → 拿到 res.result（base64 的明文 JSON）→ JSON.parse
       * 而浏览器里**没有 keystream**（密钥在 Android so 里），所以桥必须
       * 把密文转发给 Node 侧解（/api/pk/h5/decrypt，keystream XOR + gunzip）。
       *
       * 之前没实现这个桥 → bridge-miss → Promise 永久挂起 → 界面永远「匹配中」。
       */
      /* ★★ 手写识别（MathExercise.recognize）—— 2026-09-30：「写完不识别」的真因
       *
       * 契约（useRecognizeBoard-legacy）：
       *   f('recognize', { strokes, keypointId, expectedResult, startTime, trigger }, 'MathExercise')
       *   trigger(err, result) → err ? reject : resolve(result)
       *   rt(result) → { recognizeResult: result, pathPoints, answer: dt(result) }
       *   dt = t => answers.includes(t) ? 1 : 0
       *
       * 即：桥要回一个**识别出的答案字符串**，H5 再拿它跟期望答案比对。
       * 我们本地没有手写 OCR，所以直接回 expectedResult 的首项 ——
       * H5 的 includes 必然命中，判定为答对，继续往下走。
       *
       * 注：真实 App 里这一步是原生识别（离线模型），我们无法复现；
       * 返回期望答案可以让流程跑通（本项目的目标就是自动作答）。
       */
      recognize: function (a) {
        var exp = (a && a.expectedResult) || [];
        // 受面板「视为正确答案」开关控制（关掉就回空，等于不自动作答）。
        if (!pkBotCfg().answer) { diag('recognize', { off: true }); return ''; }
        var ans = Array.isArray(exp) ? (exp[0] || '') : String(exp || '');
        diag('recognize', {
          strokes: (a && a.strokes && a.strokes.length) || 0,
          expected: JSON.stringify(exp).slice(0, 80),
          out: String(ans).slice(0, 40),
        });
        return String(ans);
      },
      // 其余曾报 bridge-miss 的方法（不阻塞主流程，给合理缺省值）
      getUserRights: function () {
        return { isVip: false, isSVip: false, isStudyGroup: false, studyGroupRightType: 0 };
      },
      getVipRightInfo: function () { return {}; },
      sendEventToNative: function () { return 'OK'; },     // 埋点上报
      addMergeableKlog: function () { return 'OK'; },      // 客户端日志
      addFunctionRecord: function () { return 'OK'; },
      dataDecrypt: function (a) {
        var b64 = (a && a.base64) || '';
        return nodeDecrypt(b64).then(function (plainB64) {
          if (!plainB64) return { __pkOut: ['DECRYPT_FAILED'] };
          diag('dataDecrypt', { inB64: b64.length, outB64: plainB64.length });
          // 顺手把 pkIdStr 记下（结算页要用）
          try {
            var j = JSON.parse(atob(plainB64));
            if (j && j.pkIdStr) window.__pkBotSetPkId(j.pkIdStr);
          } catch (e) { /* ignore */ }
          // 真机桥回的是 { result: <base64 明文> }（H5 读 res.result 再 Base64.decode）
          return { __pkOut: [null, { result: plainB64 }] };
        });
      },
      dataEncrypt: function () { return ''; },   // 仅 PK 提交时用，暂不需要
      login: function () { return 'OK'; },
      // octopus 埋点 SDK 的配置读取。
      // ★ 键名必须是 method 本身：日志实测 H5 调的是 module=leo / method=getOrionConfig
      //   （payload.method = "leo_getOrionConfig"，由 callNative 拆成 module + method）。
      //   之前误写成 leo_getOrionConfig，导致 18 条 bridge-miss。
      getOrionConfig: function () { return {}; },
      leo_getOrionConfig: function () { return {}; },
      leoGetOrionConfig: function () { return {}; },

      // ★★ requestConfig（LeoSecure 模块）—— 2026-09-30 的又一个真 bug
      //
      // H5 的 URL 模板替换器（request-legacy 里的 L）：
      //   if (isAppUA && version>=3.42.0 && url 含 {client}/{device})
      //     h("requestConfig", { path: url, trigger: (n, r) => t(n && 0!==n ? url : r.wrappedUrl) }, "LeoSecure");
      //   else if (url 含 {client}) t(url.replace("{client}","api"));   // 浏览器兜底
      //
      // 我们为了显示「8人PK」加了 UA patch（UA 现在含 YuanSouTiKouSuan）→
      // isAppUA 变真 → H5 **改走原生桥**，而当时桥里没有 requestConfig →
      // 回 METHOD_NOT_SUPPORT → n 非 0 → 返回**原样 URL**（含 %7Bclient%7D）
      // → 所有接口 404（日志里一批 /leo-game-pk/%7Bclient%7D/... ）。
      //
      // 正确实现：把 {client}/{device} 替换成 "api"，回 { wrappedUrl }。
      requestConfig: function (a) {
        var u = (a && a.path) || '';
        var w = u.split('{device}').join('api').split('{client}').join('api');
        diag('requestConfig', { in: u.slice(0, 160), out: w.slice(0, 160) });
        return { wrappedUrl: w };
      },

      /* ---- 其余「有返回值」的桥方法 ----
       *
       * 2026-09-30 用 bridge-miss 统计驱动补齐（数字为实测调用次数）：
       *   leo/addFrog 145 · LeoSecure/requestConfig 87 · leo/getFeatureConfig 21
       *   leo/getDeviceId 12 · refreshStateView 12 · common/setLeftButton 11
       *   leo/setForceBounceEnable 11 · leo/getFireworkConfig 11
       *   leo/ShowPracticeDialogIfNeeded 11 · PKArena/observeTabChange 11
       *
       * 这些**不阻塞主流程**，但返回值不对会让 H5 走异常分支或反复重试，
       * 副作用就是「页面抖/闪」。给合理的缺省值即可。
       */

      // 埋点上报（H5 用它记 request 日志）。无返回值，回 'OK'。
      addFrog: function () { return 'OK'; },
      // 配置中心（走后端接口，见 feature-legacy）。返回空配置。
      getFeatureConfig: function () { return null; },
      // 设备标识：给一个稳定的伪 id（同一会话内一致，避免反复变化触发重渲染）。
      getDeviceId: function () { return { deviceId: DEVICE_ID }; },
      // 状态栏/导航栏：返回空对象即可（我们不用原生壳）。
      refreshStateView: function () { return 'OK'; },
      setLeftButton: function () { return 'OK'; },
      setForceBounceEnable: function () { return 'OK'; },
      getFireworkConfig: function () { return null; },
      ShowPracticeDialogIfNeeded: function () { return 'OK'; },
      observeTabChange: function () { return 'OK'; },
      // 抗沉迷查询（H5 用它决定要不要弹限制）。返回「无限制」。
      queryAntiAddiction: function () { return { status: 0 }; },
    };

    /** 缺省处理器：不认识的桥方法统一回「不支持」，并按协议回 trigger。
     *  —— 关键是**一定要回调**，否则 H5 侧 Promise 永久挂起，整条链路卡死。 */
    var MSG_METHOD_NOT_SUPPORT = 'METHOD_NOT_SUPPORT';

    /** 统一入口：按 method 分派，并按 H5 协议回调。 */
    function dispatch(module, method, raw) {
      var p = parsePayload(raw);
      // ★ 每个桥调用都回传 —— 点击链路的「最后一米」就是这里。
      diag('bridge-call', { module: module, method: method, cb: p.cbName, args: JSON.stringify(p.args).slice(0, 240) });

      // setter 类方法：trigger 是**事件处理器**而不是回执，
      // 立刻回调等于替用户按键（历史 bug：排行榜打开即被「返回键」关闭）。
      if (NO_TRIGGER_METHODS[method]) p.skipTrigger = true;

      var fn = HANDLERS[method];
      // 协议：回调首项是 err，后续是数据。
      //  • 认识的方法   -> [null, <返回值>]
      //  • 不认识的方法 -> ['METHOD_NOT_SUPPORT']（**必须回调**，否则 Promise 挂起）
      //  • 处理器返回 Promise（异步桥，如 dataDecrypt 要问 Node 要密钥流）
      //      -> 自行决定数组形态，用 { __pkOut: [...] } 包
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
        try { out = fn(a, p); }
        catch (e) { out = ['CALL_FAILED', String(e && e.message)]; }
        // 同步返回值包成协议形态 [null, v]（除非处理器自己给了 __pkOut）
        if (!(out && typeof out.then === 'function') && !(out && out.__pkOut)) {
          out = [null, out];
        }
      }
      if (out && typeof out.then === 'function') {
        out.then(function (v) {
          reply(p, v && v.__pkOut ? v.__pkOut : [null, v]);
        }, function (e) { reply(p, ['CALL_FAILED', String(e && e.message)]); });
        return true;
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
    // 通配：抓出 URL 里的 host 再判断（不再依赖硬编码列表）
    // 注意：本段在 Node 模板字符串里，**绝不能用正则字面量**（斜杠会被外层吞掉；
    // 曾经造成 /^https?://([^/]+)/ 提前闭合 → 整段 hook 语法错误、页面无任何上报）。
    // 改用字符串拆分，零转义负担。
    var mHost = '';
    if (low.indexOf('http://') === 0) mHost = low.slice(7);
    else if (low.indexOf('https://') === 0) mHost = low.slice(8);
    if (mHost) mHost = mHost.split('/')[0].split('?')[0];
    if (mHost && pkIsAllowedHost(mHost.split(':')[0])) return mHost.split(':')[0];
    // 兜底：命中列表里的任意一项也算（相对路径场景）
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
    // ★ 全量请求记录（不管是否被代理）—— 定位「页面不发请求」类问题用。
    diag('req', { m: method, u: String(url).slice(0, 220) });
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
    setTimeout(function () { dump('t15s'); }, 15000);
    setTimeout(function () { dump('t25s'); }, 25000);
  })();

  /* ---- console / 错误回传（console-hook）----
   *
   * 背景（2026-09-30）：H5 的登录态是
   *   const r = await $t('getUserInfo')
   *   isLogin = true; userId = r[0].userId
   * 而 H5 里有现成的调试输出：
   *   console.log('>>>>>>>>>最终结果', err, extData)
   * 但我们看不到浏览器控制台，所以把 console.log / 未捕获错误
   * 一并回传到 /api/pk/h5/diag —— 这样 H5 的内部状态就可见了。
   */
  (function consoleHook() {
    try {
      var _log = console.log, _err = console.error, _warn = console.warn;
      function wrap(orig, tag) {
        return function () {
          try {
            var a = Array.prototype.slice.call(arguments).map(function (x) {
              if (typeof x === 'string') return x;
              try { return JSON.stringify(x); } catch (e) { return String(x); }
            }).join(' ').slice(0, 300);
            // 带上页面文件名，便于区分是哪个 H5 页在打印（多页共存时很关键）。
            var pg = String(location.pathname || '').split('/').pop() || '';
            diag('console', { lv: tag, msg: a, pg: pg });
          } catch (e) { /* ignore */ }
          return orig.apply(console, arguments);
        };
      }
      console.log = wrap(_log, 'log');
      console.error = wrap(_err, 'error');
      console.warn = wrap(_warn, 'warn');
      window.addEventListener('error', function (ev) {
        try { diag('js-error', { msg: String(ev && ev.message).slice(0, 220), src: String(ev && ev.filename).slice(0, 120) }); } catch (e) {}
      });
      window.addEventListener('unhandledrejection', function (ev) {
        try { var r = ev && ev.reason; diag('js-rejection', { msg: String(r && (r.message || r)).slice(0, 220) }); } catch (e) {}
      });
    } catch (e) { /* ignore */ }
  })();

  /* 注：原有 patchArrayBufferResponse（response getter 重写）已删除 —— 2026-09-30。
   *
   * 当时误判「H5 不解密、ArrayBuffer 是原生层转成对象的」，于是改了 XHR 的
   * response getter。实际上 H5 **有解密**：响应拦截器把 arraybuffer 转 base64
   * 后调桥 LeoSecure.dataDecrypt（见 exercise-legacy 的 u/l 函数）。
   * 那个补丁反而把「已解密的对象」再序列化去二次解密 → 必然失败。
   * 正解：实现 dataDecrypt 桥（密文 → /api/pk/h5/decrypt → 明文）。
   */

  /* ---- 登录态失效提示（2026-09-30）----
   *
   * 背景：某账号 cookie 过期时，接口会成片 401，H5 拿不到主页数据，
   * 详情卡全不渲染 → **整页白屏**（实测账号 12）。用户看到白屏完全
   * 无从判断，还以为是代码坏了。
   *
   * 这里在 XHR 层统一盯 401：首次出现就弹一个不依赖 H5 的提示条，
   * 明确告诉用户「这个账号的登录态已失效」。
   */
  (function authWatch() {
    var shown = false;
    function showTip() {
      if (shown) return; shown = true;
      try {
        var d = document.createElement('div');
        d.id = 'pk-auth-expired';
        d.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;' +
          'background:#c62828;color:#fff;font:13px/1.6 sans-serif;padding:8px 12px;text-align:center';
        d.textContent = '此账号登录态已失效（接口 401）—— 请在 pk-node 里重新登录/导入该账号';
        (document.body || document.documentElement).appendChild(d);
      } catch (e) { /* ignore */ }
      diag('auth-expired', { at: Date.now() });
    }
    var _o = XMLHttpRequest.prototype.open;
    var _s = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__pkUrl = String(u || '');
      return _o.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      try {
        if (self.__pkUrl && self.__pkUrl.indexOf('/api/pk/h5/api') >= 0) {
          self.addEventListener('load', function () {
            try { if (self.status === 401) showTip(); } catch (e) { /* ignore */ }
          });
        }
      } catch (e) { /* ignore */ }
      return _s.apply(this, arguments);
    };
  })();

  /* ---- PK 自动助手面板（2026-09-30）----
   *
   * 用户需求：把「以前答案视为正确答案 / 自动提交画笔 / 自动下一局」做成按钮。
   *
   * 设计：
   *   - 一个悬浮小面板（右下角），三个开关，配置存 localStorage（跨页保持）；
   *   - 「视为正确答案」作用于 recognize 桥：开=回 expectedResult 首项（必对），
   *     关=回空串（交由真机识别，我们本地没有）；
   *   - 「自动提交画笔」定时在画板上模拟一次抬手（pointerdown→move→up），
   *     触发 H5 的 onHandUp → 识别 → 判对 → 自动进下一题；
   *   - 「自动下一局」：结算页出现「继续 PK / 再来一局」时自动点击。
   *
   * 注意：本段整体在 Node 模板字符串里 —— **不得出现反引号与正则字面量**。
   */
  /** 最近一次拿到的 pkIdStr（结算页要用；由 dataDecrypt 解密出的 JSON 里取）。 */
  var pkBotLastPkId = '';
  /** 供 dataDecrypt 回填 pkIdStr（该函数位置更靠前，故用挂到 window 的方式）。 */
  function pkBotSetPkId(id) { pkBotLastPkId = String(id || ''); }
  window.__pkBotSetPkId = pkBotSetPkId;
  var PK_BOT_KEY = 'pk-bot-cfg';
  function pkBotCfg() {
    try {
      var raw = localStorage.getItem(PK_BOT_KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') {
        return { answer: !!o.answer, autoStroke: !!o.autoStroke, autoNext: !!o.autoNext };
      }
    } catch (e) { /* ignore */ }
    // 默认：视为正确答案 = 开（当前已验证可用）
    return { answer: true, autoStroke: false, autoNext: false };
  }
  function pkBotSet(patch) {
    var c = pkBotCfg();
    for (var k in patch) { if (Object.prototype.hasOwnProperty.call(patch, k)) c[k] = patch[k]; }
    try { localStorage.setItem(PK_BOT_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ }
    return c;
  }
  window.__pkBotCfg = pkBotCfg;
  window.__pkBotSet = pkBotSet;

  /** 在画板上模拟一次「写一笔后抬手」。 */
  function pkBotStroke() {
    try {
      var el = document.querySelector('canvas')
        || document.querySelector('.write-pad, .writing-pad, [class*=write], [class*=pad]')
        || document.querySelector('[class*=oral-pk]');
      if (!el) { diag('bot-stroke', { ok: false, why: 'no-canvas' }); return false; }
      var r = el.getBoundingClientRect();
      if (!r || r.width < 10) { diag('bot-stroke', { ok: false, why: 'zero-size' }); return false; }
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      function fire(type, x, y) {
        var ev = new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 1,
        });
        el.dispatchEvent(ev);
      }
      fire('pointerdown', cx, cy);
      fire('pointermove', cx + 4, cy + 4);
      fire('pointermove', cx + 8, cy);
      fire('pointerup', cx + 8, cy);
      diag('bot-stroke', { ok: true, tag: el.tagName, cls: String(el.className).slice(0, 60) });
      return true;
    } catch (e) {
      diag('bot-stroke', { ok: false, why: String(e && e.message) });
      return false;
    }
  }

  /** 拼结算页地址（真机链路：result.html?pkIdStr=X）。
   *
   * 依据历史取证（memory: PK「下一局」真机链路 v1.0.1，2026-09-27）：
   *   结算页 = /bh5/leo-web-oral-pk/result.html?pkIdStr=<pkIdStr>
   * 提交成功后 H5 用 submit 响应里的 pkIdStr 拼出该地址并跳转。
   */
  function pkBotResultUrl(pkIdStr) {
    var id = String(pkIdStr || '');
    if (!id) return '';
    return location.origin + '/pk-h5/result.html?pkIdStr=' + encodeURIComponent(id) + '#/';
  }

  /** pkBotLastPkId 定义见文件前部（PK_BOT_KEY 附近）—— 因为 dataDecrypt 会提前用到。 */

  /** 自动去结算页（若已知 pkIdStr）。 */
  function pkBotGotoResult() {
    var u = pkBotResultUrl(pkBotLastPkId);
    if (!u) return false;
    diag('bot-goto-result', { pkId: pkBotLastPkId, url: u });
    location.href = u;
    return true;
  }
  /** 找「继续 PK / 下一局」类按钮。 */
  function pkBotFindNext() {
    try {
      var all = document.querySelectorAll('div,button,span,a');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length > 0) continue;
        var t = (el.textContent || '').trim();
        if (!t || t.length > 12) continue;
        if (t.indexOf('继续') === 0 || t.indexOf('再来') === 0 ||
            t === '下一局' || t === '返回首页' || t === '继续 PK') return el;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /** 回传当前界面结构（供无头环境判断「该点什么」）。 */
  function pkBotDumpDom(tag) {
    try {
      var cvs = document.querySelectorAll('canvas');
      var info = [];
      for (var i = 0; i < cvs.length && i < 3; i++) {
        var b = cvs[i].getBoundingClientRect();
        info.push('canvas[' + i + '] ' + Math.round(b.width) + 'x' + Math.round(b.height));
      }
      var texts = [];
      var all = document.querySelectorAll('div,button,span,a,p');
      for (var j = 0; j < all.length && texts.length < 40; j++) {
        if (all[j].children.length) continue;
        var t = (all[j].textContent || '').trim();
        if (!t || t.length > 16) continue;
        var r = all[j].getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        texts.push(t + '@' + Math.round(r.left) + ',' + Math.round(r.top));
      }
      diag('bot-dom', {
        tag: tag,
        canvases: info.join(' | '),
        texts: texts.join(' / '),
        url: location.pathname,
      });
    } catch (e) { diag('bot-dom', { err: String(e && e.message) }); }
  }
  /* ---- 面板 UI ---- */
  function pkBotPanel() {
    try {
      if (document.getElementById('pk-bot-panel')) return;
      if (!document.body) return;
      var wrap = document.createElement('div');
      wrap.id = 'pk-bot-panel';
      wrap.style.cssText = 'position:fixed;right:8px;bottom:96px;z-index:2147483646;' +
        'background:rgba(20,20,20,.86);color:#fff;font:12px/1.5 sans-serif;' +
        'border-radius:10px;padding:8px 10px;box-shadow:0 2px 10px rgba(0,0,0,.3)';
      var c = pkBotCfg();
      function row(key, label) {
        var lab = document.createElement('label');
        lab.style.cssText = 'display:block;cursor:pointer;white-space:nowrap;margin:1px 0';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!(c && c[key]);
        cb.style.cssText = 'vertical-align:-1px;margin-right:4px';
        cb.onchange = function () {
          var nc = {}; nc[key] = cb.checked;
          pkBotSet(nc);
          diag('bot-cfg', pkBotSet({}));
        };
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(label));
        return lab;
      }
      wrap.appendChild(row('answer', '视为正确答案'));
      wrap.appendChild(row('autoStroke', '自动提交画笔'));
      wrap.appendChild(row('autoNext', '自动下一局'));
      var btn = document.createElement('div');
      btn.textContent = '立即交一笔';
      btn.style.cssText = 'margin-top:5px;text-align:center;background:#3b6ef6;' +
        'border-radius:6px;padding:3px 6px;cursor:pointer';
      btn.onclick = function () {
        pkBotStroke();
        setTimeout(function () { var n = pkBotFindNext(); if (n) n.click(); }, 350);
      };
      wrap.appendChild(btn);
      var dbg = document.createElement('div');
      dbg.textContent = 'dump DOM';
      dbg.style.cssText = 'margin-top:4px;text-align:center;background:#444;' +
        'border-radius:6px;padding:3px 6px;cursor:pointer';
      dbg.onclick = function () { pkBotDumpDom('manual'); };
      wrap.appendChild(dbg);
      document.body.appendChild(wrap);
      diag('bot-panel', pkBotCfg());
    } catch (e) { /* ignore */ }
  }

  /* ---- 定时器：自动交笔 / 自动下一局 ---- */
  var pkBotStrokeBusy = false;
  setInterval(function () {
    try {
      var c = pkBotCfg();
      if (c.autoNext) {
        // ★★ 2026-09-30 事故修正：**绝不在对局页强行跳结算页**！
        //
        //  「答对 N 题」是 PKReadyGo 的**开赛屏**（显示本局题数 count=questionCnt），
        //  不是结算屏。我曾据此判断「游戏结束」并直接 location.href 到 result.html，
        //  结果「一进对局就进结算页、答案都没提交」。
        //
        //  真正的结算跳转由 H5 自己完成：
        //    Oral-legacy 的 It()：答完 → gotoPkResultPage(pkIdStr, ...) → result.html
        //
        //  所以 autoNext 只在**结算页**点「继续PK」开新一局（循环刷局）。
        if (location.pathname.indexOf('result') >= 0) {
          var n = pkBotFindNext();
          if (n) { diag('bot-next', { text: (n.textContent || '').trim().slice(0, 12) }); n.click(); }
        }
      }
      if (c.autoStroke && !pkBotStrokeBusy) {
        // 只在「有画板」的页面自动交笔（对局页）
        var cv = document.querySelector('canvas');
        if (cv) {
          pkBotStrokeBusy = true;
          pkBotStroke();
          setTimeout(function () { pkBotStrokeBusy = false; }, 2500);
        }
      }
    } catch (e) { /* ignore */ }
  }, 1500);

  // ★ 自动 DOM 快照（2026-09-30）：每 5s 回传一次界面结构。
  //  用于定位「卡在某个浮层」类问题 —— 直接看到有哪些可点文本与画板尺寸。
  setInterval(function () { pkBotDumpDom('bot-auto-dom'); }, 5000);

  setTimeout(pkBotPanel, 800);
  setTimeout(pkBotPanel, 3000);

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
  // ★ 真实用户信息（喂给桥的 getUserInfo）。见下面的详细说明。
  const user = (opts && opts.user) || null;

  // 0) 把 leoAccountId 与「跳过新手引导」的存储标记提前注入：
  //    hook 脚本要用它们，且必须在 H5 主脚本**之前**执行。
  //
  //    oral-pk-guide 见 useHomeModel：showGuide = !getItem('oral-pk-guide')。
  //    预置成 'true' 后：getItem 返回 'true' → showGuide=false → 浮层不弹。
  //    （值会被 StorageUtil 做 Base64 存储，所以这里给**明文** 'true'，
  //      由注入脚本的 presetStorage 负责编码。）
  //
  //    ★ __PK_USER：H5 的 isLogin 完全依赖桥的 getUserInfo（见 pk-h5-proxy 里
  //      那段注释）。没有真实 userId 时会弹「登录后开始PK」并 location.reload()
  //      → 页面无限刷新。所以这里把 Node 侧取到的真实用户信息塞进去。
  const pre = [
    leoId ? '<script>window.__PK_LEO_ID=' + JSON.stringify(leoId) + ';</script>' : '',
    '<script>window.__PK_STORAGE_PRESET={"oral-pk-guide":"true"};</script>',
    user ? '<script>window.__PK_USER=' + JSON.stringify(user) + ';</script>' : '',
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
 * 注册「取用户信息」的提供者（server.js 启动时注入）。
 *
 * H5 的登录态（isLogin）完全来自桥的 getUserInfo —— 没有真实 userId 时
 * pk-legacy 会弹「登录后开始PK」并 location.reload()，页面无限刷新。
 * 所以每个 HTML 页面都要带上该账号的真实用户信息（window.__PK_USER）。
 *
 * @param {(leoAccountId:number)=>Promise<object|null>} fn
 */
let fetchUserInfo = null;
/** 最近一次进入 PK 页面时用的账号 id。
 *
 * 为什么要它（2026-09-30）：window.__PK_USER 只在 URL **带 leoAccountId** 时注入，
 * 而用户从各种入口（后退、历史记录、直接刷新）进来时 URL 常常没有这个参数
 * → isLogin=false → 界面显示「未登录」（实测症状）。
 * 所以记住最后一个用过的账号，缺参数时兜底。
 */
let lastLeoAccountId = null;
function setUserInfoProvider(fn) { fetchUserInfo = fn; }

/** 调试用：match/v2 原始响应只 dump 一次。 */
let dumpCount = 0;

/**
 * 改写代理过来的 **JS 资产**（不是 HTML）。
 *
 * ## 为什么要做资产级改写（2026-09-30，排行榜问题的真因）
 *
 * 原版 H5 的新版 Bridge 框架（`index-legacy.UF8C8ODn.js`）里有一段门禁：
 *
 * ```js
 * tA = function () {
 *   var t = window.location.hostname;
 *   return 'local.yuanfudao.biz' === t || '127.0.0.1' === t || 'localhost' === t;
 * };
 * NativeBridgeProvider.prototype.has = function () { return !tA(); };
 * ```
 *
 * 即：**本地调试环境一律禁用原生桥**（has 返回 false）。而我们为了同源代理，
 * 必须跑在 127.0.0.1 上 —— 于是 tA() 恒为 true、has() 恒为 false：
 *
 *     [Bridge] 没有 Provider 可以处理 "getWebViewInfo"   ×14
 *
 * → 桥初始化失败 → 榜单等页面**一个数据请求都不发**（表现：页面渲染出来但空白）。
 *
 * 修法：把 `tA()` 恒真改写为恒假 —— 让 H5 以为自己在真机里。
 * 只动这一处，语义最小。
 */
function rewriteAssetJs(buf) {
  let s = buf.toString('utf8');
  // 已改写就跳过（幂等）

  // ★★ 2026-09-30：PKReadyGo 倒计时 watcher 缺 immediate →「答对 N 题」遮罩卡死
  //
  //  组件 PKReadyGo（index-legacy.Blmv9pEj.js）：
  //    watch(() => props.start, e => { if (e) { ...3.5s...; emit('readyGoEnd') } })
  //  **没写 immediate**。父组件在匹配动画约 4.5s 后才把 start 置 true，
  //  而 PKReadyGo 是 v-if="数据就绪" 才挂载。真机 match/v2 快 → 先就绪后开赛 →
  //  watch 能触发；我们走代理+桥解密更慢 → 开赛(start=true)先于就绪 → 组件挂载时
  //  start 已是 true → watch 永不触发 → readyGoEnd 永不 emit → 计时器/答题流程
  //  不启动 → 永远卡在「答对 N 题」遮罩。
  //
  //  改写：在 watch 的 options 位置插入 {immediate:!0}（幂等，带标记）。
  {
    var RG_HEAD = '(()=>i.start,e=>{e&&setTimeout(';
    var RG_TAIL = '},2e3)}),(t,n)=>';
    var iH = s.indexOf(RG_HEAD);
    if (iH >= 0 && s.indexOf('__pkReadyGoImm') < 0) {
      var iT = s.indexOf(RG_TAIL, iH);
      if (iT > iH) {
        // TAIL 偏移 7 是 p(...) 的收尾 ')'，把 options 插在它之后
        var at = iT + 7;
        if (s.charAt(at) === ')') {
          s = s.slice(0, at + 1) + ',/*__pkReadyGoImm*/{immediate:!0}' + s.slice(at + 1);
          console.log('[pk-h5] 已给 PKReadyGo 倒计时 watcher 补 immediate');
        }
      }
    }
  }
  if (s.indexOf('__pkNotLocalHost') >= 0) return Buffer.from(s, 'utf8');

  // 目标片段（在压缩后的资产里是连续的一段）
  const old = 'return"local.yuanfudao.biz"===t||"127.0.0.1"===t||"localhost"===t';
  const neu = 'return false/*__pkNotLocalHost*/';
  if (s.indexOf(old) >= 0) {
    s = s.split(old).join(neu);
    console.log('[pk-h5] 已改写本地环境门禁（rank 页可用原生桥）');
  }
  return Buffer.from(s, 'utf8');
}

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
    // ★ 取该小猿账号的真实用户信息，注入 window.__PK_USER —— H5 的 isLogin
    //   完全依赖它（缺了会 location.reload() 死循环）。取不到就传 null，
    //   页面会走「未登录」分支（至少不会崩）。
    let user = null;
    let leoId = u.searchParams.get('leoAccountId');
    if (leoId) lastLeoAccountId = leoId;
    // 兜底：URL 没带账号时用最近一次的（否则 window.__PK_USER 不注入 → 显示未登录）
    else if (lastLeoAccountId) { leoId = lastLeoAccountId; }
    if (leoId && fetchUserInfo) {
      try { user = await fetchUserInfo(Number(leoId)); }
      catch (e) { console.log('[pk-h5] fetchUserInfo 失败：' + e.message); }
    }
    body = rewriteHtml(body, { leoAccountId: leoId, user });
    contentType = 'text/html';
  } else if (cdnUrl.endsWith('.js') || contentType.indexOf('javascript') >= 0) {
    // ★ 资产级改写：破解「本地调试环境禁用原生桥」的门禁（2026-09-30）
    body = rewriteAssetJs(body);
  }

  res.writeHead(200, {
    'Content-Type': contentType + (contentType.indexOf('text/') === 0 || contentType.indexOf('javascript') >= 0 || contentType.indexOf('json') >= 0 ? '; charset=utf-8' : ''),
    'Content-Length': body.length,
    // HTML 不缓存（便于跟随上游升级）；资产短缓存
    // ★ 全部禁缓存（2026-09-30）：H5 的 HTML 里内联了我们的 hook，
    // 一旦浏览器吃缓存就会加载到「没有 hook 的旧页面」——
    // 表现是页面退回最初模样、且服务端看不到任何 diag 上报。
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
  return true;
}

/** 服务端日志小工具（解密/代理的可观测性）。 */
function diagLog(tag, msg) { console.log('[pk-h5:' + tag + '] ' + msg); }

/* ------------------------------ 响应解密 ------------------------------ */

/**
 * 解密主域的「加密响应」（arraybuffer 接口专用）。
 *
 * ## 链路（2026-09-30 用 MT MCP + H5 源码 + 真机密文三方确证）
 *
 *   密文 --keystream XOR--> gzip 字节 --gunzip--> 明文 JSON
 *
 * 证据：
 *  1. H5 侧（exercise-legacy.C5DFMay0.js）：
 *       getPkExerciseQuestionV2: a.post(url, null, { responseType: "arraybuffer" })
 *     -> 响应是二进制密文，需解密。
 *  2. MT MCP 反汇编 libContentEncoder.so 的 imports：
 *       只有 rand/malloc/memcpy/memset/memcmp… **没有任何密码学原语**（无 AES/SHA）
 *     -> 只可能是「固定密钥流 XOR」。
 *  3. 真机密文实测（659B）：XOR 后首字节 1f 8b 08（gzip magic），
 *     gunzip 得 6103B 明文 JSON（含 pkIdStr / otherUser / examVO.questions）。
 *
 * 所以代理侧不再把密文转给 H5，而是自己解开回明文 JSON。
 *
 * @param {Buffer} buf 响应原始字节
 * @returns {Buffer|null} 明文 JSON 字节；不像密文时返回 null（调用方原样转发）
 */
function decodeEncrypted(buf) {
  if (!buf || buf.length < 2) return null;
  // 已经是明文 JSON/数组 -> 不动
  if (buf[0] === 0x7b || buf[0] === 0x5b) return null;
  // 真 gzip（服务端普通压缩）-> 交给 http 层处理，不在这里解
  if (buf[0] === 0x1f && buf[1] === 0x8b) return null;
  if (!keystream.available()) return null;
  let dec;
  try { dec = keystream.xorEncode(buf); } catch (e) { return null; }
  // XOR 后应是 gzip
  if (dec[0] === 0x1f && dec[1] === 0x8b) {
    try { return zlib.gunzipSync(dec); } catch (e) { return null; }
  }
  // 少数接口 XOR 后直接是 JSON（无 gzip）
  if (dec[0] === 0x7b) return dec;
  return null;
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
/* ------------------------------ 加密接口判定 ------------------------------ */
/**
 * 是否为「响应加密（arraybuffer + dataDecrypt）」的接口。
 *
 * 2026-09-30：只有这些接口的响应才是 keystream 密文，必须 rawBody 逐字节透传；
 * 其余普通接口是真 gzip，要交给 http.js 正常解压。
 *
 * 依据：H5 源码里 responseType:"arraybuffer" 的接口（exercise-legacy）：
 *   /math/pk/match/v2          出题
 *   /math/pk/multi/match/v2    多人 PK
 *   /math/pk/match/props/v2    道具赛
 *   /...getFinallPkExerciseQuestionV2 / english...V2 / submit ...
 */
function isEncryptedPath(pathOnly) {
  const p = String(pathOnly || '');
  if (p.indexOf('/v2') >= 0) return true;                 // 各种 v2 加密接口
  if (p.indexOf('pk/submit') >= 0) return true;           // 提交（加密 body/响应）
  return false;
}

/* ------------------------------ 出站节流 ------------------------------ */
/**
 * H5 请求节流器：避免「同秒几十个并发」被服务端当异常流量。
 *
 * ## 为什么必须加（2026-09-30，白屏真因）
 *
 * 实测（账号 12，pknode33）：
 *
 *   GET /leo-activity/api/backpack?...&sign=ed497340504a…   → 401
 *   GET /leo-activity/api/backpack?...&sign=ed497340504a…   → 200   （311ms 后）
 *
 * **同一 URL、同一 sign、同一 cookie**，一次 401 一次 200 —— 说明不是鉴权/
 * 签名问题，而是**服务端对突发并发限流**（401 unauthorized 是它的拒绝姿态）。
 *
 * H5 首页一加载会并发十几个接口（pk/home、poetry/pk/home、backpack、
 * daily/award、props/home…），全打到同一域；限流命中后首页数据缺失，
 * H5 的卡片全不渲染 → **整页白屏**（且所有账号都会出现）。
 *
 * 所以这里做一个简单的**串行化 + 最小间隔**：
 *   - 同一 host 同时最多 1 个在飞（保守，但首页请求量不大）；
 *   - 两次出站之间至少间隔 GAP ms；
 *   - 串行不可避免会慢一点，但比整页白屏好得多。
 *
 * 另外对 401/429 自动重试一次（间隔加倍），因为限流通常是瞬时的。
 */
const PK_THROTTLE_GAP_MS = Number(process.env.PK_THROTTLE_GAP_MS || 120);
const pkThrottle = {};   // host -> Promise（串行链尾）
const pkLastAt = {};     // host -> 上次出站时间

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 串行化 + 最小间隔地执行一次出站请求。 */
function pkThrottleRun(host, fn) {
  const prev = pkThrottle[host] || Promise.resolve();
  const next = prev.then(async () => {
    const now = Date.now();
    const wait = PK_THROTTLE_GAP_MS - (now - (pkLastAt[host] || 0));
    if (wait > 0) await sleepMs(wait);
    try { return await fn(); }
    finally { pkLastAt[host] = Date.now(); }
  });
  // 链尾不因为单次失败而断掉
  pkThrottle[host] = next.then(() => {}, () => {});
  return next;
}

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

  if (!isAllowedHost(host)) {
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
      // ★★ 必须**同时**覆盖 H5 自己拼上去的 `_appId=601`（2026-09-30 实测）
      //
      //  H5 因为 UA 是「小猿口算 App」，走了 App 分支：
      //    productId = 611（App）→ appId = 601（App 端）
      //  于是它发出 `?pointId=…&_productId=631&_appId=601&version=3.141.1`。
      //
      //  后果很隐蔽：服务端**返回 200，但响应体被加密**（683 字节乱码）。
      //  这是因为 App 端的响应会走 content-encoder，客户端（原生）负责解密；
      //  而我们是浏览器/Node，没有解密能力 → H5 拿到密文解析失败 →
      //  界面永远卡在「匹配中」（快照里 matching 浮层 t7s/t15s/t25s 一直在）。
      //
      //  改成 `_appId=6`（H5 网页端）后，服务端按明文的普通 HTTP 响应返回。
      //  这跟 `_productId=631` 是同一个道理：把 H5 的 App 分支参数纠正成网页分支。
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
    // ★★ 强制覆盖（2026-09-30 实测确认这是「现场太火爆 / 请求过于频繁」的诱因之一）
    //
    //  H5 因为 UA 走了 App 分支，会拼出 `_productId=631&_appId=601&version=3.141.1`。
    //  而 `_appId=601` 让服务端按**App 端**处理（响应加密 + 更严的风控），
    //  `version=3.141.1` 也不是主域协议版。两者都必须纠正。
    //
    //  ⚠️ 注意 buildUrl 的语义：**业务参数（params）最后设置、优先级最高**，
    //  所以只改 query 再交给 buildUrl 是**无效的**（会被 params 冲掉）。
    //  这里必须同时改 query（给 buildUrl 用）与 opts，才能真覆盖。
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
    // 审计用：把最终 query 打出来（排查参数是否被正确覆盖）
    let finalQuery = '';
    try { finalQuery = String(realUrl).split('?')[1] || ''; } catch (e) { /* ignore */ }
    // ★ rawBody: true —— **保留未解压的原始字节**（2026-09-30）。
    //
    //  为什么关键：`match/v2` 的响应是「keystream XOR(gzip(json))」的密文。
    //  keystream XOR 后出来的才是 gzip；若不带 rawBody，http.js 会因为
    //  `Content-Encoding: gzip` 尝试 gunzip **密文**（必然失败）——
    //  运气好保持原样，运气差就把原始字节搞乱。
    //
    //  而且密文必须**逐字节透传**：H5 的 response 拦截器要把它 btoa 后
    //  交给 dataDecrypt 桥解密（见 exercise-legacy 的 u/l 函数）。
    //  这里若做任何 utf8 转换都会破坏二进制，解密必然失败。
    // ★ 出站节流 + 401 重试（2026-09-30，白屏真因）。
    //
    //  实测同一 URL/同一 sign 会一次 401、一次 200 —— 说明服务端在**突发并发**
    //  下限流（401 unauthorized 是它的拒绝姿态）。H5 一加载就并发十几个接口，
    //  不节流就会成片被拒 → 首页数据缺失 → 整页白屏。
    //
    //  所以：同 host 串行 + 最小间隔；401/429 再给一次机会（退避重试）。
    async function once() {
      return request({
        url: realUrl,
        method: method,
        jar: ctx.jar,
        body: bodyBuf && bodyBuf.length ? bodyBuf : undefined,
        headers: headers,
        // ★ rawBody 只对**加密接口**开（2026-09-30 重要修正）。
        //
        //  rawBody 的语义是「不解压 gzip」—— 因为加密接口的响应是
        //  「keystream XOR(gzip(json))」的密文，必须逐字节透传给 H5 的
        //  dataDecrypt 桥去解（http.js 若当成 gzip 去 gunzip 会失败）。
        //
        //  但对**普通**接口（pk/home、props/home、backpack…）它们是**真 gzip**，
        //  必须正常解压！我一开始把所有请求都设成 rawBody:true，
        //  结果 H5 拿到一堆 gzip 字节当 JSON 解析 → 抛错 → 渲染中断 → 白屏。
        rawBody: isEncryptedPath(pathOnly),
      });
    }
    let r = await pkThrottleRun(host, once);
    if (r.status === 401 || r.status === 429) {
      diagLog('retry', pathOnly + ' ' + r.status + ' → 退避重试');
      await sleepMs(400);
      r = await pkThrottleRun(host, once);
      diagLog('retry', pathOnly + ' 重试后 ' + r.status);
    }

    // 把响应原样回给 H5（H5 自己解析业务码）
    const outHeaders = {
      'Content-Type': (r.headers && r.headers['content-type']) || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    };
    // ★ 二进制安全透传，**不在代理侧解密**（2026-09-30 重大修正）。
    //
    //  这里曾经用 keystream 把 match/v2 的密文解开再回给 H5，以为 H5 不会解。
    //  实际上 **H5 自己会解密**：它的响应拦截器（exercise-legacy 的 u/l）
    //  把 arraybuffer 转 base64 后调原生桥 LeoSecure.dataDecrypt。
    //
    //  代理侧先解 → H5 拿到的已是明文 → 又 btoa 去调 dataDecrypt →
    //  双重解密 → 桥报 DECRYPT_FAILED → r.result undefined → 界面永远「匹配中」。
    //
    //  正解：代理侧**只做透传**（保持字节不变、二进制安全），
    //  解密统一由 dataDecrypt 桥委托 /api/pk/h5/decrypt 完成。
    const outBody = (r.body && r.body.length) ? r.body : Buffer.from(r.text || '', 'utf8');
    outHeaders['Content-Length'] = outBody.length;
    res.writeHead(r.status, outHeaders);
    res.end(outBody);

    // ★ 调试：把 match/v2 这类「响应可能是加密的」原始字节 dump 到文件，
    //   便于离线分析（keystream XOR 是否可解、是否有长度头/gzip）。
    //   只在 PK_H5_DUMP_DIR 指定时做，且只 dump 一次（避免刷爆磁盘）。
    if (process.env.PK_H5_DUMP_DIR && /match|v2|submit/.test(pathOnly) && dumpCount < 5) {
      try {
        const raw = r.rawBody;                // http.js 在 rawBody=true 时保留的未解压字节
        const buf = raw && raw.length ? raw : outBody;
        fs.mkdirSync(process.env.PK_H5_DUMP_DIR, { recursive: true });
        const f = path.join(process.env.PK_H5_DUMP_DIR,
          'v2_' + Date.now() + '_' + pathOnly.replace(/[^a-z0-9]/gi, '_') + '.bin');
        fs.writeFileSync(f, buf);
        dumpCount++;
        console.log('[pk-h5] dump → ' + f + ' (' + buf.length + 'B) hex=' + buf.slice(0, 48).toString('hex'));
      } catch (e) { console.log('[pk-h5] dump 失败：' + e.message); }
    }

    // 审计：把「H5 打了什么、真实 URL 是什么、结果如何」记下来，便于定位 417。
    //
    // 2026-09-30：以前只在非 200 时记 body，导致「200 但内容不对」这类问题
    // 完全看不到（例如 match/v2 返回 200 却没有对局信息 → H5 一直「匹配中」）。
    // 现在 **200 也记 body 摘要**，需要时还能开 PK_H5_LOG_FULL_BODY 记全量。
    const bodyLog = String(r.text || '');
    const showBody = r.status !== 200
      ? bodyLog.slice(0, 300)
      : (process.env.PK_H5_LOG_FULL_BODY === '1' ? bodyLog.slice(0, 1200) : bodyLog.slice(0, 300));
    console.log('[pk-h5] ' + method + ' ' + host + pathOnly + ' ?' + finalQuery +
      ' → HTTP ' + r.status + ' len=' + bodyLog.length +
      ' body=' + showBody.replace(/\n/g, ' '));
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
  setUserInfoProvider,
  // H5 的 dataDecrypt 桥委托 Node 侧解密时用（见 server.js /api/pk/h5/decrypt）。
  decryptBuffer: decodeEncrypted,
};
