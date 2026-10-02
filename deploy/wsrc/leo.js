// 主域请求的签名 / 请求头 / URL 组装（Worker 版）。
//
// 对应本机 pk-node 的 src/leo.js（riskHeaders / leoUserAgent / sw28Header /
// mainDomainHeaders / buildUrl / maybeSign），逻辑逐条对齐。

import { calcT } from './emu.js';
import { chainMd5 } from './sign.js';
import {
  LEO_BASE, PK_COMMON, MAIN_COMMON, MAIN_PREFIXES,
  PRODUCT_ID, DEVICE, RISK_HEADERS,
} from './signcfg.js';

// ---------------------------------------------------------------- sign

/**
 * T 的缓存：key = `variant|minute`。
 *
 * ⚠️ 服务端校验 T 的**时效**（实测只接受 ±1 分钟），所以必须按分钟算，不能长期复用。
 * 但同一分钟内多个请求可以共享一次 calcT —— 这能把 CPU 摊薄到约 5ms/分钟。
 */
const tCache = new Map();

function tFor(variant, minute) {
  const key = variant + '|' + minute;
  let t = tCache.get(key);
  if (!t) {
    t = calcT(minute * 60, variant);
    if (tCache.size > 8) tCache.clear();
    tCache.set(key, t);
  }
  return t;
}

/** 该路径用哪套签名资产（用错会 417）。 */
export function variantFor(urlPath) {
  return String(urlPath).indexOf('/leo-game-pk') === 0 ? 'pk' : 'exercise';
}

/** 该路径是否需要签名（PK v1 出题不需要；其余主域端点都要）。 */
export function needSign(urlPath) {
  const p = String(urlPath);
  if (p === '/leo-game-pk/android/math/pk/match') return false;
  return true;
}

/** 算 sign（32 位 hex）；不需要签名的路径返回 null。 */
export function calcSign(urlPath) {
  if (!needSign(urlPath)) return null;
  const minute = Math.floor(Date.now() / 60000);
  const T = tFor(variantFor(urlPath), minute);
  return chainMd5(urlPath, T);
}

// ---------------------------------------------------------------- headers

/** App 原生 UA：`Leo/<版本> (<BRAND><MODEL>; Android 17; Scale/3.25)`。 */
export function leoUserAgent() {
  return 'Leo/' + PK_COMMON[1][1] +
    ' (' + DEVICE.brand + DEVICE.model + '; Android ' + DEVICE.uaSdk + '; Scale/' + DEVICE.scale + ')';
}

/** 20 位小写十六进制 traceId。 */
export function randomTraceId() {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 20; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

function b64utf8(s) {
  // btoa 只接受 latin1；traceId 是 ASCII，直接可用。
  return btoa(s);
}

/** `default-namespace-sw8`：b64("1")-b64(traceId)-b64("0")-0-<固定尾>。 */
export function sw8Header(traceId) {
  return b64utf8('1') + '-' + b64utf8(traceId) + '-' + b64utf8('0') + '-0-X19PX1JfVF9f-UF9J-UF9F-SV9Q';
}

/**
 * 主域 App 原生请求头（417 的解药）。
 * 缺 x-shepherd-did / leo-client-trace-id / default-namespace-sw8 时主域端点会 417。
 */
export function mainDomainHeaders(extra, shepherdDid) {
  const traceId = randomTraceId();
  const h = Object.assign({
    'User-Agent': leoUserAgent(),
    Accept: 'application/json',
    'X-App-Version': PK_COMMON[1][1],
    'X-Channel': 'official',
    'X-XYKS-REQ-TIMESTAMP': String(Date.now()),
  }, RISK_HEADERS, {
    'leo-client-trace-id': traceId,
    'default-namespace-sw8': sw8Header(traceId),
  });
  if (shepherdDid) h['x-shepherd-did'] = shepherdDid;
  return Object.assign(h, extra || {});
}

/** 风控头（PK/H5 系用）。 */
export function riskHeaders() {
  return Object.assign({ 'X-XYKS-REQ-TIMESTAMP': String(Date.now()) }, RISK_HEADERS);
}

// ---------------------------------------------------------------- url

/**
 * 组装主域请求 URL。
 *
 * ⚠️ `_productId` 必须放最前（原版真机顺序；放最后时 accounts/switch 直接 400）。
 */
export function buildUrl(urlPath, params, opts) {
  const o = opts || {};
  const isMain = MAIN_PREFIXES.some((pre) => String(urlPath).indexOf(pre) === 0);
  const parts = [];
  parts.push(['_productId', o.productId || PRODUCT_ID]);
  if (o.appId) parts.push(['_appId', o.appId]);
  for (const kv of (isMain ? MAIN_COMMON : PK_COMMON)) parts.push(kv);
  for (const k of Object.keys(params || {})) {
    if (params[k] == null) continue;
    parts.push([k, String(params[k])]);
  }
  const sign = calcSign(urlPath);
  const q = parts
    .filter((kv) => kv[1] != null)
    .map((kv) => encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1]))
    .join('&');
  return LEO_BASE + urlPath + '?' + (sign ? q + '&sign=' + sign : q);
}
