'use strict';
// 极简 HTTP 客户端 + cookie 管理（零外部依赖，基于 node:https）。
//
// 只做本项目需要的三件事：
//   1. 发请求（可指定 method/headers/body、可选 follow redirect）；
//   2. 解析 Set-Cookie 并合并进 cookie 表（按 domain 匹配，支持前导点与 host-only）；
//   3. 按请求 host 生成 Cookie 头。
//
// ⚠️ cookie 的 domain 匹配必须正确处理「前导点」：
//    domain=".yuanfudao.com" → 所有 *.yuanfudao.com 子域都带；
//    domain="xyks.yuanfudao.com"（host-only）→ 只有该 host 带。
//    这是 PK H5「登录态丢失」的历史坑之一，别退化成字符串 includes。

const https = require('node:https');
const http = require('node:http');
const zlib = require('node:zlib');
const { URL } = require('node:url');

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 17; onyx Build/AP3A) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 ' +
  'YuanSouTiKouSuan/3.141.1';

/** host-only cookie 与域 cookie 的匹配判定。 */
function domainMatches(cookieDomain, host) {
  const d = String(cookieDomain || '').trim().toLowerCase();
  const h = String(host || '').trim().toLowerCase();
  if (!d) return false;
  if (d.startsWith('.')) {
    // 域 cookie：host 必须是该域或其子域
    return h === d.slice(1) || h.endsWith(d);
  }
  // 无前导点：可能是 host-only，也可能服务端省略了点；两者都按「精确或子域」处理
  return h === d || h.endsWith('.' + d);
}

/**
 * cookie 表。内部是扁平数组，元素 {name,value,domain,path}。
 *
 * 不用 Map 是因为 cookie 的标识是 (name, domain, path) 三元组，
 * 而本项目 cookie 量很小（十几条），数组足够且最简单。
 */
class CookieJar {
  constructor(items) {
    this.items = Array.isArray(items) ? items.map(normalizeCookie).filter(Boolean) : [];
  }

  /** 从一份「Cookie: a=1; b=2」头字符串导入（domain 全给 host-only 的 baseHost）。 */
  static fromHeader(header, baseHost) {
    const jar = new CookieJar([]);
    jar.importHeader(header, baseHost);
    return jar;
  }

  importHeader(header, baseHost) {
    for (const part of String(header || '').split(';')) {
      const s = part.trim();
      if (!s) continue;
      const i = s.indexOf('=');
      if (i <= 0) continue;
      this.set({
        name: s.slice(0, i).trim(),
        value: s.slice(i + 1).trim(),
        domain: '.' + String(baseHost).replace(/^\./, ''),
        path: '/',
      });
    }
  }

  /** 写入/覆盖一条 cookie（按 name+domain 去重，保留服务端最新值）。 */
  set(c) {
    const n = normalizeCookie(c);
    if (!n) return;
    const i = this.items.findIndex((x) => x.name === n.name && x.domain === n.domain);
    if (i >= 0) this.items[i] = n;
    else this.items.push(n);
  }

  /** 解析一组 Set-Cookie 头并写入。 */
  absorbSetCookie(setCookieList, requestHost) {
    for (const raw of setCookieList || []) {
      const parsed = parseSetCookie(raw, requestHost);
      if (parsed) this.set(parsed);
    }
  }

  /** 生成发给 host 的 Cookie 头（path 用 '/' 判定即可，本项目全站同一路径）。 */
  headerFor(host, pathname = '/') {
    const h = String(host).toLowerCase();
    const p = pathname || '/';
    const parts = [];
    for (const c of this.items) {
      if (!domainMatches(c.domain, h)) continue;
      if (c.path && !p.startsWith(c.path)) continue;
      parts.push(c.name + '=' + c.value);
    }
    return parts.join('; ');
  }

  get(name) {
    const c = this.items.find((x) => x.name === name);
    return c ? c.value : null;
  }

  toJSON() {
    return this.items.slice();
  }
}

function normalizeCookie(c) {
  if (!c || c.name == null) return null;
  return {
    name: String(c.name).trim(),
    value: String(c.value == null ? '' : c.value),
    domain: String(c.domain == null ? '' : c.domain).trim(),
    path: String(c.path == null ? '/' : c.path).trim() || '/',
  };
}

/** 解析单条 Set-Cookie。属性里的 Domain/Path 覆盖默认。 */
function parseSetCookie(raw, requestHost) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const segs = s.split(';');
  const first = segs[0];
  const i = first.indexOf('=');
  if (i <= 0) return null;

  const cookie = {
    name: first.slice(0, i).trim(),
    value: first.slice(i + 1).trim(),
    domain: requestHost,
    path: '/',
  };
  for (let k = 1; k < segs.length; k++) {
    const seg = segs[k].trim();
    const j = seg.indexOf('=');
    const key = (j >= 0 ? seg.slice(0, j) : seg).trim().toLowerCase();
    const val = j >= 0 ? seg.slice(j + 1).trim() : '';
    if (key === 'domain' && val) cookie.domain = val;
    else if (key === 'path' && val) cookie.path = val;
  }
  return cookie;
}

/**
 * 发一个 HTTP(S) 请求。
 *
 * @param {object} o
 * @param {string} o.url
 * @param {string} [o.method]
 * @param {object} [o.headers]
 * @param {Buffer|string} [o.body]
 * @param {CookieJar} [o.jar]      会自动带上并吸收 Set-Cookie
 * @param {number} [o.timeoutMs]
 * @param {boolean} [o.rawBody]    为 true 时不解码 gzip、不转字符串
 * @param {AbortSignal} [o.signal] 中断信号（「立即结束」用：会在途请求直接掐断）
 * @returns {Promise<{status:number, headers:object, body:Buffer, text:string}>}
 */
function request(o) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(o.url); } catch (e) { return reject(new Error('URL 非法：' + o.url)); }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;

    // 已经中断的直接拒绝，别白跑一趟
    if (o.signal && o.signal.aborted) return reject(abortError(o.url));

    const headers = Object.assign(
      {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip',
      },
      o.headers || {},
    );
    if (o.jar) {
      const ck = o.jar.headerFor(u.hostname, u.pathname);
      if (ck) headers.Cookie = ck;
    }
    if (o.body != null && headers['Content-Length'] == null) {
      headers['Content-Length'] = Buffer.byteLength(o.body);
    }

    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: o.method || 'GET',
        headers,
        timeout: o.timeoutMs || 30000,
        // Node 原生支持 signal：中断时等价于 req.destroy()
        signal: o.signal,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          if (o.jar) o.jar.absorbSetCookie(res.headers['set-cookie'], u.hostname);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          if (!o.rawBody && enc === 'gzip') {
            try { buf = zlib.gunzipSync(buf); } catch (e) { /* 保持原样 */ }
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: buf,
            text: buf.toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时：' + o.url)));
    req.on('error', (e) => {
      // 被 signal 掐断时给出统一错误标识，便于上层识别（而不是当成网络故障）
      if (o.signal && o.signal.aborted) return reject(abortError(o.url));
      reject(e);
    });
    if (o.body != null) req.write(o.body);
    req.end();
  });
}

/** 统一的中断错误：上层靠 `err.aborted === true` 识别。 */
function abortError(url) {
  const e = new Error('已中断：' + url);
  e.aborted = true;
  return e;
}

module.exports = { request, CookieJar, parseSetCookie, domainMatches, DEFAULT_UA };