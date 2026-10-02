'use strict';
// 真·PK 页面（H5）服务端代理：把 H5（HTML+资产）代理到本机同源，注入 XHR hook 改写请求，
// 由 Node 用该账号 cookie 补签名/风控头/公共参数后转发。资产从 CDN 内存缓存。

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
 * 允许被代理的 API host（不在名单里的会被 400 拒绝，见 [proxyApi]）。
 * ytk 的 /accounts/api/current 是登录态查询，漏掉会导致 H5 判不出登录态。
 */
const API_HOSTS = [
  'xyks.yuanfudao.com',
  'xyst.yuanfudao.com',
  'ape-api.yuanfudao.com',
  'oapi.yuanfudao.com',
  'ytk.yuanfudao.com',
];

/**
 * 是否允许代理该 host：通配 *.yuanfudao.com（含 .biz）。
 * 原版 H5 各子页面会打不同业务域，漏一个则该页数据请求不走代理 → 渲染空白。
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
 * 在 H5 脚本执行前注入的 hook：包一层 XMLHttpRequest，把落到名单 host 的请求改写成本机
 * 同源 /api/pk/h5/api（原始 host 放入 X-PK-Target，Node 侧还原）。H5 的 axios 基于 XHR。
 */
const H5_INJECT = `(function () {
  var TARGET_HOSTS = ['xyks.yuanfudao.com', 'xyst.yuanfudao.com', 'ape-api.yuanfudao.com', 'oapi.yuanfudao.com', 'ytk.yuanfudao.com'];
  /* 允许代理的 host 判定（与 Node 侧 isAllowedHost 一致）：通配 *.yuanfudao.com，
     原版 H5 各子页面会打不同业务域（leo-homework/leo-activity/...），漏掉则空白。 */
  function pkIsAllowedHost(h) {
    var x = String(h || '').toLowerCase();
    if (!x) return false;
    if (TARGET_HOSTS.indexOf(x) >= 0) return true;
    return /\.yuanfudao\.(com|biz)$/.test(x);
  }
  var LOCAL = '/api/pk/h5/api';
  // 稳定的伪设备 id：同一会话内必须一致，否则 H5 反复重渲染（界面抖/闪）。
  var DEVICE_ID = 'pknode-' + Math.random().toString(36).slice(2, 10);

  /* 伪装成小猿 App 的 WebView UA：H5 靠 UA 是否含 "YuanSouTiKouSuan" 判断是否 App 内，
     决定 8人PK/巅峰赛等入口是否渲染。只追加不替换。 */
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

  /* 预置 H5 localStorage 标记（Base64 格式），跳过「新手引导」全屏遮罩
     （oral-pk-guide 缺省时浮层会盖住按钮导致点了没反应）。 */
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

  /* 最小 Buffer polyfill：H5 回调解析器用 new Buffer(t,'base64').toString()，浏览器无 Buffer
     → 抛错、Promise 永不 resolve。仅实现 base64 解码 + toString()。 */
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

  /* 点击链路诊断：捕获阶段监听 click + hashchange，定位「点了有反馈但不跳转」断点。 */
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

  /* 原生桥模拟：PK H5 的跳转都让原生开新 WebView（native://openWebView?url=…），浏览器里
     CommonWebView/LeoWebView 不存在 → 点了没反应。故补桥，并转为同窗口导航。 */
  (function installBridge() {
    /* 桥协议（payload 为 base64）：window.CommonWebView.<method>(b64) 或
       window.LeoWebView.callNative(b64)。回调形态 window[<trigger|callback>](base64([err,...data]))，
       err===null 为成功；H5 传 trigger 时不注册 callback，须用 trigger 当回调名。 */
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
     * 不能回调 trigger 的桥方法（setter 语义）：其 trigger 是「事件处理器」，登记后等用户
     * 真正操作才回调，登记时立即回调等于替用户按键。这些方法只回复执（obj.callback）。
     */
    var NO_TRIGGER_METHODS = {
      setLeftButton: 1,
      setOnVisibilityChange: 1,
      refreshStateView: 1,
      setForceBounceEnable: 1,
      observeTabChange: 1,
      // setOnInteractivePopped：trigger 是原生稍后回调的一次性处理器，只登记不回调（避免立即触发融合打卡致页面乱跳）。
      setOnInteractivePopped: 1,
    };

    /** 把结果按协议回给页面：window[cbName](base64([err, ...data]))。
     *  p.skipTrigger 为真时只回复执（obj.callback），不触碰 trigger。 */
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

    /** 最近一次 openWebView 的时间戳（用于 closeWebView 的语义判断）。 */
    var pkJustOpenedWebView = 0;
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
            // 绝不往 result.html 注入 isFromHistory：结算页靠它区分「看历史」（不提交）与
            // 「真机结算」（PUT /math/pk/submit），误注入 =true 会导致提交被跳过。
            if (local.indexOf('result.html') >= 0 && local.indexOf('isFromHistory') < 0) {
              diag('result-no-history', { local: local.slice(0, 160) });
            }
            diag('openWebView', { url: target.slice(0, 300), local: local.slice(0, 300) });
            // 本机把「开新 WebView」实现为同窗口导航。置「刚开过 WebView」标记：
            // 真机 openWebView 后常紧接着 closeWebView 关自己，同窗口下会 history.back() 误伤新页。
            pkJustOpenedWebView = Date.now();
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

    /** 给同源地址补上 leoAccountId（下级页靠它找账号，缺了 404）。跳转前补回，
     *  放在 ? 之后、# 之前以免破坏 hash 路由。 */
    function addLeoId(u) {
      var id = window.__PK_LEO_ID || '';
      if (!u) return u;
      var add = [];
      if (id && u.indexOf('leoAccountId=') < 0) add.push('leoAccountId=' + encodeURIComponent(id));
      // ?pkbot= 只挂在入口页 URL，H5 跳到 exercise/result 时自拼 URL 不带 → 开关全回「关」，
      // 故跳转时一并带上。
      if (u.indexOf('pkbot=') < 0) add.push('pkbot=' + encodeURIComponent(pkBotCurrentRaw()));
      if (!add.length) return u;
      var hashIdx = u.indexOf('#');
      var hash = hashIdx >= 0 ? u.slice(hashIdx) : '';
      var base = hashIdx >= 0 ? u.slice(0, hashIdx) : u;
      var sep = base.indexOf('?') >= 0 ? '&' : '?';
      return base + sep + add.join('&') + hash;
    }

    /** 把任意外部 H5 地址折成本机同源地址（否则下级页没有 hook 与桥）。
     *  <任意源>/bh5/<目录>/<页面> → /pk-h5-cdn/<目录>/<页面>；主目录 → /pk-h5/<x>。 */
    function toLocalH5(url) {
      var u = String(url || '');
      if (!u) return u;
      var low = u.toLowerCase();
      if (low.indexOf('data:') === 0 || low.indexOf('blob:') === 0 ||
          low.indexOf('javascript:') === 0) return u;
      // 同源 /bh5/<目录>/ 也归一到 /pk-h5-cdn/<目录>/（本机无 /bh5/ 路由）。
      if (u.indexOf(location.origin) === 0) {
        var samePath = u.slice(location.origin.length);
        var bhp2 = '/bh5/';
        var bi = samePath.indexOf(bhp2);
        if (bi === 0) {
          var rest2 = samePath.slice(bhp2.length);
          var cdnOral2 = 'leo-web-oral-pk/';
          if (rest2.indexOf(cdnOral2) === 0) {
            return location.origin + '/pk-h5/' + rest2.slice(cdnOral2.length);
          }
          return location.origin + '/pk-h5-cdn/' + rest2;
        }
        return u;
      }

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
     *  H5 响应拦截器对 arraybuffer 响应会调桥 LeoSecure.dataDecrypt 自行解密，
     *  故桥把密文 POST 给 /api/pk/h5/decrypt 拿回明文 JSON 的 base64，再按协议回调。 */
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
    /** 把明文交给 Node 侧加密（浏览器无 keystream）。加密 = gzip + keystream XOR
     *  （见 src/native.js encodeSubmitBody）。 */
    function nodeEncrypt(b64) {
      return new Promise(function (resolve) {
        try {
          var x = new XMLHttpRequest();
          x.open('POST', '/api/pk/h5/encrypt', true);
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

    var FEATURE_CONFIG = {
      // pk-legacy / useHomeModel：未登录也允许 PK。取值字符串 'true'/'false'。
      'leo.unlogin.pk': 'false',
      // usePreschoolGate：显示学龄前入口。'true'/'false'。
      'leoShowPreschool': 'false',
      // useNavigation：对局页用 oral-merge.html(true) 还是 exercise.html(false)。
      'leoOralPKExerciseUseMerge': 'false',
        // 融合荣誉榜开关：inUse=true 会让结算页「返回」变「继续 PK 打卡」而非返回，真机常规环境为 false。
        'leo.fusion.honor.ranking.config': { content: { inUse: false } },
      // pk-legacy：校园赛季入口 → e.content.enable
      'leo.oral.pk.schoolSeason.entry': { content: { enable: false } },
      // ready_go：匹配等待文案 → o.content.courses[].imageUrl
      'leo.pk.matching.waiting.text': { content: { courses: [] } },
    };
    /** 取功能开关值。键名可能来自 featureKey（getFeatureConfig）或 orionKey（getOrionConfig）。
     *  未收录的键返回 null（H5 会走 HTTP 兜底 → 404 → 用它自己的默认值，与现状一致）。 */
    function featureValue(key) {
      var k = String(key || '');
      if (Object.prototype.hasOwnProperty.call(FEATURE_CONFIG, k)) {
        diag('feature-config', { key: k, hit: true });
        return FEATURE_CONFIG[k];
      }
      diag('feature-config', { key: k, hit: false });
      return null;
    }

    var HANDLERS = {
      openSchema: handleOpenSchema,
      // H5 的跳转既可能发 openSchema（schemas 数组），也可能直接发 openWebView。
      // 两条都接住，避免漏一种写法。
      openWebView: function (args) { return handleOpenSchema({ schemas: ['native://openWebView?' + (args && args.url ? 'url=' + encodeURIComponent(args.url) : '')] }); },
      closeWebView: function () {
        // 同窗口导航下，旧页的 closeWebView 是「已被替换者发来的迟到消息」本该丢弃；
        // 否则 history.back() 会把刚打开的结算页顶掉 → 答完题返回主界面。故 3 秒内刚 openWebView 则忽略。
        if (Date.now() - pkJustOpenedWebView < 3000) {
          diag('closeWebView-ignored', { sinceOpenMs: Date.now() - pkJustOpenedWebView });
          return 'OK';
        }
        diag('closeWebView-back', {});
        history.back();
        return 'OK';
      },
      getWebViewInfo: function () { return { version: BRIDGE_VERSION, platform: 'android' }; },
      setTitle: function () { return 'OK'; },
      toast: function () { return 'OK'; },
      loading: function () { return 'OK'; },
      setOnVisibilityChange: function () { return 'OK'; },
      jsLoadComplete: function () { return 'OK'; },
      getImmerseStatusBarHeight: function () { return 0; },
      getDeviceInfo: function () { return { platform: 'android', appVersion: BRIDGE_VERSION }; },
      // H5 头像/胜场/昵称首选来源；必须返回真实 userId，否则 isLogin 恒 false →
      // pk-legacy 弹「登录后开始PK」并 location.reload() 死循环。数据由 Node 注入 window.__PK_USER。
      getUserInfo: function () { return window.__PK_USER || {}; },
      /* getBasicInfo（桥调用器里的 r("B")）：未实现会走 callNative 兜底回 undefined →
         初始化提前结束（页面停「0 胜 / 胜率 0%」）。回基础信息对象即可。 */
      getBasicInfo: function () {
        var u = window.__PK_USER || {};
        return { userId: u.userId || 0, gradeId: u.gradeId || 0 };
      },
      /* 练习入口能力桥：getExerciseInfo 回 {exerciseGradeId, exerciseSemesterId}；
         getExerciseConfig 回 {grade, semester, bookMath, bookChinese, bookEnglish}。 */
      getExerciseInfo: function () {
        var g = Number(window.__PK_GRADE || (window.__PK_USER && window.__PK_USER.gradeId) || 0) || 1;
        diag('getExerciseInfo', { grade: g });
        return { exerciseGradeId: g, exerciseSemesterId: 1 };
      },
      getExerciseConfig: function () {
        var g = Number(window.__PK_GRADE || (window.__PK_USER && window.__PK_USER.gradeId) || 0) || 1;
        diag('getExerciseConfig', { grade: g });
        return { grade: g, semester: 1, bookMath: 1, bookChinese: 4, bookEnglish: 10 };
      },

      /* dataDecrypt（LeoSecure）：H5 对 arraybuffer 调本桥解密，浏览器无 keystream，转发 Node
         /api/pk/h5/decrypt。不实现则 Promise 永久挂起 → 界面永远「匹配中」。 */
      /* recognize：本地无手写 OCR，直接回 expectedResult 首项（H5 includes 命中 → 判对）。 */
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
      /* dataEncrypt（LeoSecure）：提交对局结果前 H5 把明文交本桥加密，回 { result: <加密字节> }，
         H5 用 Uint8Array(result) 当 body。空实现会导致 H5 判「encrypt data fail」而放弃提交
         → 局数/胜场不涨。加密 = gzip + keystream XOR，转发 Node 的 /api/pk/h5/encrypt。 */
      dataEncrypt: function (a) {
        var b64 = (a && a.base64) || '';
        return nodeEncrypt(b64).then(function (cipherB64) {
          if (!cipherB64) return { __pkOut: ['ENCRYPT_FAILED'] };
          diag('dataEncrypt', { inB64: b64.length, outB64: cipherB64.length });
          return { __pkOut: [null, { result: cipherB64 }] };
        });
      },
      login: function () { return 'OK'; },
      // 键名必须是 method 本身（H5 经 callNative 拆出 module+method，如 leo_getOrionConfig）。
      /* 功能开关：H5 的 feature() 优先走本桥，否则 HTTP orion 端点（全 404 → 降级默认，入口异常）。
         故直接回正确形态的值（形态来自各调用点，勿凭感觉改）。 */
      getOrionConfig: function (a) {
        return featureValue(a && (a.orionKey || a.featureKey || a.key));
      },
      leo_getOrionConfig: function (a) {
        return featureValue(a && (a.orionKey || a.featureKey || a.key));
      },
      leoGetOrionConfig: function (a) {
        return featureValue(a && (a.orionKey || a.featureKey || a.key));
      },

      // requestConfig（LeoSecure）：把 URL 模板的 {client}/{device} 替换为 "api"；
      // 缺本桥会回原样含 %7Bclient%7D 的 URL → 全部 404。
      requestConfig: function (a) {
        var u = (a && a.path) || '';
        var w = u.split('{device}').join('api').split('{client}').join('api');
        diag('requestConfig', { in: u.slice(0, 160), out: w.slice(0, 160) });
        return { wrappedUrl: w };
      },

      /* 其余「有返回值」的桥方法：不阻塞主流程，但返回值不对会让 H5 走异常分支或反复重试（页面抖/闪），
         故按契约给合理缺省值。以下逐个按 H5 源码补齐。 */

      // 埋点上报（H5 用它记 request 日志）。无返回值，回 'OK'。
      addFrog: function () { return 'OK'; },
      // 配置中心（feature flag）：必须回**真实值**，H5 优先走本桥，否则走 HTTP（orion 端点 404 → 降级默认）。取值见 FEATURE_CONFIG / featureValue()。
      getFeatureConfig: function (a) {
        return featureValue(a && (a.featureKey || a.orionKey || a.key));
      },
      // 设备标识：给一个稳定的伪 id（同一会话内一致，避免反复变化触发重渲染）。
      getDeviceId: function () { return { deviceId: DEVICE_ID }; },
      // 状态栏/导航栏：返回空对象即可（我们不用原生壳）。
      refreshStateView: function () { return 'OK'; },
      setLeftButton: function () { return 'OK'; },
      setForceBounceEnable: function () { return 'OK'; },
      getFireworkConfig: function () { return null; },
      // ShowPracticeDialogIfNeeded 的实现在下方「桥补齐」区（返回 {dialogNeedToShow:false}，非 'OK'）。
      observeTabChange: function () { return 'OK'; },
      // 抗沉迷查询（H5 用它决定要不要弹限制）。返回「无限制」。
      queryAntiAddiction: function () { return { status: 0 }; },

      /* 以下桥方法：全量扫描 H5 各页的桥调用点，与 HANDLERS 做差集后按源码契约补齐。 */
      // 结算页弹窗（Result-legacy kt()）：无登录记录时用它拿「经验值」。
      //   Q('getUnloggedUserExerciseExperience', { trigger:(a,i) => {
      //        a ? reject(a) : resolve({ ..., lastExp: i.experience, ... }) } }, 'leo')
      // ★ 必须回 { experience: <number> }，否则 resolve 出 lastExp=undefined。
      getUnloggedUserExerciseExperience: function () { return { experience: 0 }; },
      // 结算页随后上报：Q('addUnloggedUserExerciseRecord', {obtainExperience, ruleType}, 'leo')
      addUnloggedUserExerciseRecord: function () { return 'OK'; },
      // 官方 PK 主页（pk-legacy lt()）：能力 >= 3.118 时问「练习弹窗要不要弹」。
      //   x('ShowPracticeDialogIfNeeded', { trigger:(e,t) => { !e && t && t.dialogNeedToShow } }, 'leo')
      // ★ trigger 是**查询回调**（H5 读 t.dialogNeedToShow），必须回 {dialogNeedToShow:false}。
      ShowPracticeDialogIfNeeded: function () { return { dialogNeedToShow: false }; },
      // 旧版弹窗入口（能力 < 3.118 时调，无 trigger 语义）。
      ShowMultiExpToolDialogIfNeeded: function () { return 'OK'; },
      // 网络失败处理（request-legacy networkFailedManageByJsb）：
      //   a('networkFailedManage', {errorCode, message}, 'leo').then(e => e ? reject(...) : resolve())
      // ★ 返回值 e 为真 → H5 视为「失败」并 reject；回 '' 才 resolve。
      networkFailedManage: function () { return ''; },
      // 分享成图（Result-legacy / index-legacy.CHYoHfC0）：无返回值，只回执。
      doShareAsImage: function () { return 'OK'; },
      // 定位（oral-pk-legacy h()）：l('3.69.0') 时走本桥，期望 a.latitude / a.longitude。
      getLocation: function () { return { latitude: 0, longitude: 0 }; },
      // 应用商店版本判定（pk-legacy）。回 false = 不是商店版（我们不是 App 壳）。
      isAppStoreVersion: function () { return false; },
      // 评分弹窗（useRatingPopup）：
      //   d() = new Promise(t => o('getRatingPopupFrequency', { trigger:(r,e) => t(r ? null : e) }, 'leo'))
      //   ★ r 非空 → t(null) → H5 判定「不弹」；回对象则走频率判定。给 null 最保守。
      getRatingPopupFrequency: function () { return null; },
      // 主动展示评分弹窗（无 trigger）。回 'OK'。
      showRatingPopup: function () { return 'OK'; },
      // 回弹（下拉橡皮筋）开关：Oral-legacy / Result-legacy 都调 setBounceEnable。
      // ★ 日志实测有 2 处调用，但 HANDLERS 此前只有 setForceBounceEnable → 会 bridge-miss。
      setBounceEnable: function () { return 'OK'; },
      /* setOnInteractivePopped：trigger 是「原生稍后回调」的一次性处理器，登记即回调会页面乱跳，
         故只登记不回调（见 NO_TRIGGER_METHODS）。 */
      setOnInteractivePopped: function () { return 'OK'; },
    };
    // 测试钩子：把桥处理器暴露给 Node 沙箱（tools/test-feature-config.js），便于对纯函数桥做断言，无需开浏览器。
    // 必须紧跟 HANDLERS 定义（同一作用域）。
    window.__pkHandlers = HANDLERS;
    /** 缺省处理器：不认识的桥方法统一回「不支持」，并按协议回 trigger。
     *  —— 关键是**一定要回调**，否则 H5 侧 Promise 永久挂起，整条链路卡死。 */
    var MSG_METHOD_NOT_SUPPORT = 'METHOD_NOT_SUPPORT';

    /** 统一入口：按 method 分派，并按 H5 协议回调。 */
    function dispatch(module, method, raw) {
      var p = parsePayload(raw);
      // 每个桥调用都回传诊断（点击链路「最后一米」）。
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

    /** 造「方法名 → 处理器」的桥对象：H5 先试 window[首字母大写(module)+'WebView'][method](payload)，
     *  再试 window.LeoWebView.callNative(payload)；两种入参都只有一个 base64 串。 */
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

    // getWebViewInfo 的版本必须过 H5 的版本下限（X(l,n)<0 判不支持），给个足够高的值即可。
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

  /* console / 错误回传：把 console.log / 未捕获错误一并回传 /api/pk/h5/diag，
     这样无头环境下 H5 的内部状态可见。 */
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

  /* 注：曾改写 XHR response getter 去「代 H5 解密」，但 H5 本身会调 dataDecrypt 桥解密，
     那个补丁反而导致二次解密失败，已删除。正解就是实现 dataDecrypt 桥。 */

  /* 登录态失效提示：cookie 过期时接口成片 401、H5 整页白屏。这里在 XHR 层盯 401，
     首次出现就弹一个不依赖 H5 的提示条。 */
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

  /* PK 自动助手（三个开关，配置存 localStorage，跨页保持）：
     · answer    —— recognize 桥回 expectedResult 首项（必对）；
     · autoStroke—— 定时在画板模拟抬手，触发 H5 的 onHandUp → 识别 → 判对 → 下一题；
     · autoNext  —— 结算页自动点「继续 PK」开新一局。
     注意：本段整体在 Node 模板字符串里，不得出现反引号与正则字面量。 */
  /** 最近一次拿到的 pkIdStr（结算页要用；由 dataDecrypt 解密出的 JSON 里取）。 */
  var pkBotLastPkId = '';
  /** 供 dataDecrypt 回填 pkIdStr（该函数位置更靠前，故用挂到 window 的方式）。 */
  function pkBotSetPkId(id) { pkBotLastPkId = String(id || ''); }
  window.__pkBotSetPkId = pkBotSetPkId;
  var PK_BOT_KEY = 'pk-bot-cfg';

  /* 配置来源：入口 URL 的 ?pkbot=<逗号分隔能力>（如 pkbot=answer,autoStroke,autoNext）。
     未带 pkbot 时读 localStorage（兼容旧值），否则全关（不默认开 answer）。 */
  function pkBotFromUrl() {
    try {
      var q = String(location.search || '');
      var m = q.match(/[?&]pkbot=([^&#]*)/);
      if (!m) return null;
      var raw = decodeURIComponent(m[1] || '');
      var parts = raw.split(',').map(function (s) { return s.trim().toLowerCase(); });
      return {
        answer: parts.indexOf('answer') >= 0,
        autoStroke: parts.indexOf('autostroke') >= 0,
        autoNext: parts.indexOf('autonext') >= 0,
      };
    } catch (e) { return null; }
  }

  function pkBotCfg() {
    // ① URL 参数优先（浏览器/无头抓取都走这条）
    var fromUrl = pkBotFromUrl();
    if (fromUrl) {
      // 读到就落盘：子页面（exercise/result）URL 上通常没有 pkbot，只能靠存下来的值。
      pkBotSet(fromUrl);
      return fromUrl;
    }
    // ② 兼容旧值（早期悬浮窗 / ①写入的值）
    var fromStore = pkBotFromStorage();
    if (fromStore) return fromStore;
    // ③ 默认全关（★ 不再默认开 answer）
    return { answer: false, autoStroke: false, autoNext: false };
  }
  /** 只读 localStorage 里的配置（不触发写入）。 */
  function pkBotFromStorage() {
    try {
      var raw = localStorage.getItem(PK_BOT_KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') {
        return { answer: !!o.answer, autoStroke: !!o.autoStroke, autoNext: !!o.autoNext };
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  function pkBotSet(patch) {
    // ⚠️ 不能调 pkBotCfg()（会递归）：只从 localStorage 基线合并。
    var c = pkBotFromStorage() || { answer: false, autoStroke: false, autoNext: false };
    for (var k in patch) { if (Object.prototype.hasOwnProperty.call(patch, k)) c[k] = patch[k]; }
    try { localStorage.setItem(PK_BOT_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ }
    return c;
  }
  /** 当前生效的能力 → URL 参数串（'answer,autoStroke,autoNext'；全关给 'off'）。 */
  function pkBotCurrentRaw() {
    var c = pkBotCfg();
    var a = [];
    if (c.answer) a.push('answer');
    if (c.autoStroke) a.push('autoStroke');
    if (c.autoNext) a.push('autoNext');
    return a.length ? a.join(',') : 'off';
  }
  window.__pkBotCfg = pkBotCfg;
  window.__pkBotSet = pkBotSet;
  window.__pkBotRaw = pkBotCurrentRaw;
  // 测试钩子（tools/test-pk-h5-bot.js 用）。运行时无害。
  window.__pkBotStroke = pkBotStroke;
  window.__pkBotFindNext = pkBotFindNext;

  /** 造一个 Touch 对象（Chrome 支持 Touch 构造器；不支持时退回鸭子类型对象）。 */
  function pkBotMakeTouch(target, x, y) {
    try {
      return new Touch({
        identifier: 1, target: target,
        clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y,
        radiusX: 4, radiusY: 4, rotationAngle: 0, force: 0.5,
      });
    } catch (e) {
      return {
        identifier: 1, target: target,
        clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y,
        force: 0.5,
      };
    }
  }
  /** 发一个 TouchEvent（targetTouches 的长度决定手写板认不认这次手势）。 */
  function pkBotFireTouch(target, type, list, active) {
    var act = active ? list : [];
    var ev = null;
    try {
      ev = new TouchEvent(type, {
        view: window, bubbles: true, cancelable: true, composed: true,
        touches: act, targetTouches: act, changedTouches: list,
      });
    } catch (e) {
      // 极少见：环境没有 TouchEvent 构造器 → 用普通 Event + 手挂三个列表
      ev = document.createEvent('Event');
      ev.initEvent(type, true, true);
      try { ev.touches = act; ev.targetTouches = act; ev.changedTouches = list; } catch (e2) { /* ignore */ }
    }
    target.dispatchEvent(ev);
  }
  /** 发一个 MouseEvent（buttons 必须对：手写板用它判断「是不是按住左键」）。 */
  function pkBotFireMouse(target, type, x, y, buttons) {
    target.dispatchEvent(new MouseEvent(type, {
      view: window, bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: buttons, detail: 1,
    }));
  }

  /**
   * 在画板上模拟一次「写一笔后抬手」。
   * 手写板（signature_pad 移植，forceUseTouch）总是绑 mousedown、且支持触摸时再绑
   * touchstart，从不绑 pointerdown，故这里严格镜像：
   *   'ontouchstart' in window → touch 事件；否则 → mouse 事件（buttons:1）。
   * 注意 _handleTouchStart 要求 targetTouches.length===1、_handleTouchEnd 要求 ===0。
   */
  function pkBotStroke() {
    try {
      var el = document.querySelector('canvas.canvas')
        || document.querySelector('canvas')
        || document.querySelector('.write-pad, .writing-pad, [class*=write], [class*=pad]')
        || document.querySelector('[class*=oral-pk]');
      if (!el) { diag('bot-stroke', { ok: false, why: 'no-canvas' }); return false; }
      var r = el.getBoundingClientRect();
      if (!r || r.width < 10 || r.height < 10) {
        diag('bot-stroke', { ok: false, why: 'zero-size', w: r && Math.round(r.width) });
        return false;
      }
      var cx = r.left + r.width * 0.5;
      var cy = r.top + r.height * 0.55;
      // 一小段折线。画的内容不重要：判对由 recognize 桥接管（服务端只在
      // 提交时回放笔迹做「有没有写」的一致性检查，不要求与答案字形一致）。
      var pts = [[cx - 16, cy + 8], [cx - 7, cy - 8], [cx + 6, cy + 8], [cx + 16, cy - 6]];
      var useTouch = ('ontouchstart' in window);
      var i;
      if (useTouch) {
        for (i = 0; i < pts.length; i++) {
          pkBotFireTouch(el, i === 0 ? 'touchstart' : 'touchmove',
            [pkBotMakeTouch(el, pts[i][0], pts[i][1])], true);
        }
        var last = pts[pts.length - 1];
        pkBotFireTouch(el, 'touchend', [pkBotMakeTouch(el, last[0], last[1])], false);
      } else {
        pkBotFireMouse(el, 'mousedown', pts[0][0], pts[0][1], 1);
        for (i = 1; i < pts.length; i++) pkBotFireMouse(el, 'mousemove', pts[i][0], pts[i][1], 1);
        pkBotFireMouse(el, 'mouseup', pts[pts.length - 1][0], pts[pts.length - 1][1], 0);
      }
      diag('bot-stroke', { ok: true, mode: useTouch ? 'touch' : 'mouse', tag: el.tagName, cls: String(el.className).slice(0, 40) });
      return true;
    } catch (e) {
      diag('bot-stroke', { ok: false, why: String(e && e.message) });
      return false;
    }
  }

  /** 拼结算页地址：result.html?pkIdStr=<pkIdStr>（提交成功后 H5 用它跳转）。 */
  function pkBotResultUrl(pkIdStr) {
    var id = String(pkIdStr || '');
    if (!id) return '';
    return location.origin + '/pk-h5/result.html?pkIdStr=' + encodeURIComponent(id) + '#/';
  }

  /** pkBotLastPkId 定义见文件前部（dataDecrypt 会提前用到）。 */

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
        // 结算页按钮文案含「继续PK / 继续挑战 / 再练一次」，故匹配「继续/再练/再来」；
        // 不匹配「返回首页」（那是离开按钮，点它等于放弃刷局）。
        if (t.indexOf('继续') === 0 || t.indexOf('再练') === 0 || t.indexOf('再来') === 0) {
          var r = el.getBoundingClientRect();
          if (r && r.width > 6 && r.height > 6) return el;
        }
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
        // 回报「模式开关」当前状态与全部 localStorage 键：pk.html 有 CLASSICS/PROPS
        // 两个模式共用一块面板，停在哪决定用户看到哪些入口。
        mode: (function () {
          try {
            var SW = document.querySelectorAll('[class*=mode-switch] .switch');
            var act = document.querySelector('[class*=mode-switch] [class*=active-bar]');
            var left = act ? (act.style && act.style.left) : '';
            var sw = document.querySelectorAll('.mode-switch .switch');
            return 'switchCount=' + sw.length + ' activeLeft=' + left;
          } catch (e) { return 'err:' + (e && e.message); }
        })(),
        ls: (function () {
          try {
            var out = [];
            for (var z = 0; z < localStorage.length; z++) {
              var k = localStorage.key(z);
              out.push(k + '=' + String(localStorage.getItem(k)).slice(0, 40));
            }
            return out.join(' | ').slice(0, 900);
          } catch (e) { return 'err:' + (e && e.message); }
        })(),
      });
    } catch (e) { diag('bot-dom', { err: String(e && e.message) }); }
  }
  /** 悬浮窗 UI 已移除；自动能力改由入口 URL 的 ?pkbot= 驱动（见 pkBotFromUrl）。 */

  /* ---- 定时器：自动交笔 / 自动下一局 ---- */
  var pkBotStrokeBusy = false;
  var pkBotLastNextAt = 0;
  setInterval(function () {
    try {
      var c = pkBotCfg();
      if (c.autoNext) {
        // 绝不从对局页强行跳结算页（「答对 N 题」是开赛屏不是结算屏）；结算跳转由 H5
        // 自己完成。autoNext 只在结算页点「继续PK」。加 3s 冷却避免连点。
        if (location.pathname.indexOf('result') >= 0) {
          if (Date.now() - pkBotLastNextAt > 3000) {
            var n = pkBotFindNext();
            if (n) {
              pkBotLastNextAt = Date.now();
              diag('bot-next', { text: (n.textContent || '').trim().slice(0, 12) });
              n.click();
            }
          }
        }
      }
      if (c.autoStroke && !pkBotStrokeBusy) {
        // 只在**对局页**自动交笔（主页也有 canvas，按路径收窄）。
        var p = String(location.pathname || '');
        var onExercise = p.indexOf('exercise') >= 0 || p.indexOf('oral-merge') >= 0;
        var cv = onExercise ? (document.querySelector('canvas.canvas') || document.querySelector('canvas')) : null;
        if (cv) {
          pkBotStrokeBusy = true;
          pkBotStroke();
          setTimeout(function () { pkBotStrokeBusy = false; }, 2000);
        }
      }
    } catch (e) { /* ignore */ }
  }, 1500);

  // 自动 DOM 快照：每 5s 回传界面结构；加载后 1.2/3/6s 各补一次（无头抓取存活短）。
  setTimeout(function () { pkBotDumpDom('t1.2s'); }, 1200);
  setTimeout(function () { pkBotDumpDom('t3s'); }, 3000);
  setTimeout(function () { pkBotDumpDom('t6s'); }, 6000);

  /* 悬浮窗调用已移除：自动能力改由 URL 参数 ?pkbot= 驱动。 */

  window.__pkH5Hook = { version: 2, local: LOCAL, hosts: TARGET_HOSTS };
})();`;

/**
 * 改写 H5 的 HTML：把 CDN 绝对 URL 换成本机同源路径，并注入 hook。
 * 注入必须在 `<head>` 第一个 script 之前（H5 的 request 模块加载时就定义好 axios）。
 * @param {Buffer} html 原始 HTML
 * @returns {Buffer} 改写后的 HTML
 */
function rewriteHtml(html, opts) {
  let s = html.toString('utf8');
  const leoId = opts && opts.leoAccountId != null ? String(opts.leoAccountId) : '';
  // 真实用户信息（喂给桥的 getUserInfo）。
  const user = (opts && opts.user) || null;

  // 0) 提前注入 leoAccountId 与「跳过新手引导」标记（hook 与主脚本之前执行）。
  //    oral-pk-guide 预置为明文 'true' → showGuide=false → 浮层不弹（presetStorage 会编码）。
  //    __PK_USER：H5 的 isLogin 依赖它，没有真实 userId 会死循环刷新。
  const pre = [
    leoId ? '<script>window.__PK_LEO_ID=' + JSON.stringify(leoId) + ';</script>' : '',
    '<script>window.__PK_STORAGE_PRESET={"oral-pk-guide":"true"};</script>',
    user ? '<script>window.__PK_USER=' + JSON.stringify(user) + ';</script>' : '',
    // 年级单独暴露一份，供 getExerciseInfo/getExerciseConfig 等能力桥使用。
    user && user.gradeId
      ? '<script>window.__PK_GRADE=' + JSON.stringify(Number(user.gradeId) || 0) + ';</script>'
      : '',
  ].join('');

  // 1) 把 CDN 上的 H5 目录换成本机 /pk-h5 前缀
  //    例：https://leo.fbcontent.cn/bh5/leo-web-oral-pk/assets/x.js → /pk-h5/assets/x.js
  s = s.split(CDN_HOST + H5_BASE_PATH + '/').join(LOCAL_PREFIX + '/');
  //    H5 页面本身的引用（不带 assets），如 .../pages/xxx.html
  s = s.split(CDN_HOST + H5_BASE_PATH).join(LOCAL_PREFIX);
  // 2) 其余 CDN 目录（leo-common-bundle 等）→ /pk-h5-cdn/<path>
  s = s.split(CDN_HOST + '/bh5/').join(LOCAL_PREFIX + '-cdn/');
  s = s.split(CDN_HOST + '/').join(LOCAL_PREFIX + '-cdn/');

  // 2.5) 其它源上的同构 H5：跳转目标还有业务域上的 H5 目录（xyks/bh5/* 等），
  //  与 CDN 内容一致。不折算的话跳到真实域名后没有 hook 与桥 → 下级页哑掉。
  //  故把 <协议>://<任意主机>/bh5/<目录>/<页面> 统一折成 /pk-h5-cdn/<目录>/<页面>。
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
 * H5 的 isLogin 完全来自桥的 getUserInfo，没有真实 userId 时 pk-legacy 会弹
 * 「登录后开始PK」并 location.reload() 死循环，故每个 HTML 都要注入 window.__PK_USER。
 * @param {(leoAccountId:number)=>Promise<object|null>} fn
 */
let fetchUserInfo = null;
/** 最近一次进入 PK 页面时用的账号 id：window.__PK_USER 只在 URL 带 leoAccountId 时注入，
 *  而用户从后退/历史/刷新进来时常没这个参数 → 显示「未登录」，故记住最后一个兜底。 */
let lastLeoAccountId = null;
function setUserInfoProvider(fn) { fetchUserInfo = fn; }

/** 调试用：match/v2 原始响应只 dump 一次。 */
let dumpCount = 0;

/**
 * 改写代理过来的 JS 资产（不是 HTML）。
 *
 * H5 的 Bridge 框架里有一段门禁：本地调试环境（127.0.0.1/localhost）一律禁用原生桥，
 * 而我们为同源代理必须跑在 127.0.0.1 → 桥初始化失败 → 榜单等页面不发请求（渲染空白）。
 * 修法：把门禁里的 `tA()` 恒真改写为恒假，让 H5 以为自己在真机里。只动这一处。
 */
function rewriteAssetJs(buf) {
  let s = buf.toString('utf8');
  // 已改写就跳过（幂等）

  // PKReadyGo 组件的倒计时 watcher 没写 immediate，而我们的 match 更慢、组件挂载时
  // start 已为 true → watch 永不触发 → 卡在「答对 N 题」遮罩。改写：给它补 {immediate:!0}。
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
 * HTML 会被改写（URL 同源化 + 注入 hook）；其余资产原样透传。
 * `-cdn` 支持任意目录：PK 跳转目标不止 leo-web-oral-pk，其它 H5 应用也需同源+hook，
 * 而 xyks/bh5/* 与 CDN 内容一致，故统一从 CDN 取。
 * @returns {Promise<boolean>} true = 已处理（响应已写）
 */
async function serve(req, res, u) {
  let cdnUrl = null;
  const path = u.pathname;

  if (path === '/pk-h5' || path === '/pk-h5/' || path === '/pk-h5/pk.html') {
    cdnUrl = CDN_HOST + H5_BASE_PATH + '/pk.html';
  } else if (path.indexOf('/bh5/') === 0) {
    // 兼容直接访问 `/bh5/<目录>/<页面>`：H5 有入口直接拼 `${location.origin}/bh5/...`，
    // 本机无此路由 → 「未提供」。映射到 /pk-h5-cdn/<目录>/x（主目录走 /pk-h5/<x>）。
    const rest = path.slice('/bh5/'.length);
    if (rest.indexOf('leo-web-oral-pk/') === 0) {
      cdnUrl = CDN_HOST + H5_BASE_PATH + '/' + rest.slice('leo-web-oral-pk/'.length);
    } else {
      cdnUrl = CDN_HOST + '/bh5/' + rest;
    }
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
    // 取该账号真实用户信息注入 window.__PK_USER（H5 的 isLogin 依赖它，缺了会死循环）。
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
    // 资产级改写：破解「本地调试环境禁用原生桥」的门禁
    body = rewriteAssetJs(body);
  }

  res.writeHead(200, {
    'Content-Type': contentType + (contentType.indexOf('text/') === 0 || contentType.indexOf('javascript') >= 0 || contentType.indexOf('json') >= 0 ? '; charset=utf-8' : ''),
    'Content-Length': body.length,
    // 全部禁缓存：HTML 里内联了 hook，吃缓存会加载到「没有 hook 的旧页面」。
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
 * 链路：密文 --keystream XOR--> gzip 字节 --gunzip--> 明文 JSON。
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
 * 还原真实 URL（路径在 X-PK-Path 头）、用 [leo.buildUrl] 补公共参数与 sign、
 * 补风控头、用该账号的 cookie jar。
 * @param {object} ctx { jar, rawBody }
 */
/* ------------------------------ 加密接口判定 ------------------------------ */
/**
 * 是否为「响应加密（arraybuffer + dataDecrypt）」的接口：只有这些接口的响应是
 * keystream 密文，必须 rawBody 逐字节透传；其余普通接口是真 gzip，交给 http.js 解压。
 */
function isEncryptedPath(pathOnly) {
  const p = String(pathOnly || '');
  if (p.indexOf('/v2') >= 0) return true;                 // 各种 v2 加密接口
  if (p.indexOf('pk/submit') >= 0) return true;           // 提交（加密 body/响应）
  return false;
}

/* ------------------------------ 出站节流 ------------------------------ */
/**
 * H5 请求节流器：同一 URL/sign/cookie 会一次 401、一次 200，说明服务端对突发并发
 * 限流（401 是拒绝姿态）。H5 首页并发十几个接口，被限流就整页白屏。故做串行化 +
 * 最小间隔（同 host 同时最多 1 个在飞、两次出站至少隔 GAP ms）。
 */
const PK_THROTTLE_GAP_MS = Number(process.env.PK_THROTTLE_GAP_MS || 120);
const pkThrottle = {};   // host -> Promise（串行链尾）
const pkLastAt = {};     // host -> 上次出站时间

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 首屏关键请求优先出站：pk.html 首屏并发 6+ 个 xyks 请求，若一律 FIFO，
 *  `math/pk/home`（决定卡片是否渲染）可能排最后 → 卡片不显示。
 *  故给关键请求开优先通道（仍受最小间隔约束）。 */
const PK_PRIORITY_PATHS = [
  '/leo-game-pk/api/math/pk/home',
  '/leo-game-pk/api/math/pk/props/home',
  '/leo-game-pk/api/math/pk/match',
];
function pkIsPriorityPath(pathAndQuery) {
  const p = String(pathAndQuery || '');
  for (let i = 0; i < PK_PRIORITY_PATHS.length; i++) {
    if (p.indexOf(PK_PRIORITY_PATHS[i]) >= 0) return true;
  }
  return false;
}

/**
 * 是否为「匹配/出题」类请求。match/v2 返回 400/429 时 H5 会弹「PK现场太火爆」弹窗，
 * 而服务端冷却只有 ~1s，退避重试几次基本必得 200，故这类请求给足重试预算。
 */
function pkIsMatchPath(pathAndQuery) {
  const p = String(pathAndQuery || '');
  return p.indexOf('/match') >= 0 || p.indexOf('/eliminate/') >= 0;
}

/** 这一次响应值得重试几次（0 = 不重试）。 */
function pkRetryBudget(status, text, pathAndQuery) {
  // 出题/匹配：400/403/429 都是瞬时频控，给足预算（H5 见了会弹「太火爆」）
  if (pkIsMatchPath(pathAndQuery) && (status === 400 || status === 403 || status === 429)) return PK_RETRY_MAX;
  if (status === 429) return 2;
  // 401 只重试 1 次：基本都是登录态失效，重试多了会让整页每个请求拖十几秒。
  if (status === 401) return 1;
  const t = String(text || '');
  if (t.indexOf('请求过于频繁') >= 0 || t.indexOf('频繁') >= 0 || t.indexOf('火爆') >= 0) return 2;
  return 0;
}

/** 出站重试上限 / 退避基数（可用环境变量调）。 */
const PK_RETRY_MAX = Number(process.env.PK_H5_RETRY_MAX || 6);
const PK_RETRY_GAP_MS = Number(process.env.PK_H5_RETRY_GAP_MS || 900);

/** 串行化 + 最小间隔地执行一次出站请求。
 *  @param {boolean} [priority] 关键请求：不与普通队列排队（直接插队，只受间隔约束）。
 */
function pkThrottleRun(host, fn, priority) {  const gate = async () => {
    const now = Date.now();
    const wait = PK_THROTTLE_GAP_MS - (now - (pkLastAt[host] || 0));
    if (wait > 0) await sleepMs(wait);
    try { return await fn(); }
    finally { pkLastAt[host] = Date.now(); }
  };
  // 关键请求：直接跑（不接在 pkThrottle[host] 链尾）
  if (priority) return gate();
  const prev = pkThrottle[host] || Promise.resolve();
  const next = prev.then(gate);
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
  // xyst 的 solar-activity 同样被 solar-encoder 保护，无 sign 会 417，故也走这条。
  let realUrl;
  if (isHostLeo || isHostSolar) {
    const isPk = pathOnly.indexOf('/leo-game-pk') === 0;
    // 强制覆盖 PK 的 _productId：H5 在浏览器里跑会按 hostname 兜底算出 _productId=131，
    // 而 PK 端点认的是 611（见下），不覆盖就会被冲掉。
    if (isPk) {
      // PK 出题真实参数：_productId=611 且不带 _appId（真机抓包口径）。
      query._productId = '611';
      delete query._appId;
    }
    // 必须同时改 query 与 opts 才能真覆盖：buildUrl 里业务参数（params）优先级最高，
    // 只改 query 会被冲掉。version/platform/vendor 用 config.js 的 PK.commonQuery。
    query.version = PK.commonQuery.version;
    query.platform = PK.commonQuery.platform;
    query.vendor = PK.commonQuery.vendor;
    realUrl = leo.buildUrl(pathOnly, query, {
      // PK 与其余主域端点统一走默认 `_productId=611`，且都不带 `_appId`。
      productId: undefined,
      appId: undefined,
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
    // rawBody: true 保留未解压的原始字节：match/v2 的响应是「keystream XOR(gzip(json))」
    // 密文，必须逐字节透传（http.js 若当 gzip 解压会搞乱字节）。
    async function once() {
      return request({
        url: realUrl,
        method: method,
        jar: ctx.jar,
        body: bodyBuf && bodyBuf.length ? bodyBuf : undefined,
        headers: headers,
        // rawBody 只对加密接口开：普通接口（pk/home 等）是真 gzip，必须正常解压，
        // 否则 H5 拿到 gzip 字节当 JSON 解析 → 白屏。
        rawBody: isEncryptedPath(pathOnly),
      });
    }
    // 首屏关键请求走优先通道（见 pkIsPriorityPath）
    const prio = pkIsPriorityPath(pathOnly);
    let r = await pkThrottleRun(host, once, prio);
    // 频控自动重试：把 match 的瞬时 400/429 挡在代理层，用户就看不到「太火爆」弹窗。
    let tries = 0;
    // 每次拿到响应**重新**算预算：某次重试换来了别的错误码（如 404），就该停下。
    for (;;) {
      const budget = pkRetryBudget(r.status, r.text, pathOnly);
      if (tries >= budget) break;
      tries++;
      const wait = Math.min(4000, PK_RETRY_GAP_MS * tries);
      diagLog('retry', pathOnly + ' ' + r.status + ' → 退避 ' + wait + 'ms 后重试（第 ' + tries + '/' + budget + ' 次）');
      await sleepMs(wait);
      r = await pkThrottleRun(host, once, prio);
      diagLog('retry', pathOnly + ' 重试后 ' + r.status);
    }

    // 把响应原样回给 H5（H5 自己解析业务码）
    const outHeaders = {
      'Content-Type': (r.headers && r.headers['content-type']) || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    };
    // 二进制安全透传，不在代理侧解密：H5 自己会调 dataDecrypt 桥解密，代理先解会双重
    // 解密 → 报 DECRYPT_FAILED → 界面永远「匹配中」。
    const outBody = (r.body && r.body.length) ? r.body : Buffer.from(r.text || '', 'utf8');
    outHeaders['Content-Length'] = outBody.length;
    res.writeHead(r.status, outHeaders);
    res.end(outBody);

    // 调试：把 match/v2 这类加密响应原始字节 dump 到文件（仅 PK_H5_DUMP_DIR 指定时）。
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

    // 审计：记录真实 URL 与结果。200 也记 body 摘要（「200 但内容不对」才看得到），
    // 需要时可开 PK_H5_LOG_FULL_BODY 记全量。
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
  // 频控重试判定（tools/test-pk-h5-bot.js 会直接断言它）
  pkIsMatchPath,
  pkRetryBudget,
  // H5 的 dataDecrypt 桥委托 Node 侧解密时用（见 server.js /api/pk/h5/decrypt）。
  decryptBuffer: decodeEncrypted,
};
