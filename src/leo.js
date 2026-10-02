'use strict';
// 小猿口算协议层：URL 组装（公共参数 + sign）+ PK 接口调用 + 子账号接口。
//
// 公共参数「逐参数补齐」而非整体覆盖：PK 端点要 `_productId=631&_appId=6`，
// 其余主域要 `_productId=611`；整体覆盖会把 631 冲成 611 → PK 直接 401。
// `sign` 的输入是 encodedPath（不含 query），在 URL 定稿后计算。

const { URL, URLSearchParams } = require('node:url');
const { config, PK } = require('./config');
const { request, CookieJar } = require('./http');
const nativeLib = require('./native');
const zlib = require('node:zlib');
const keystream = require('./keystream');

/** 主域（leo-gateway / leo-profile / leo-auth / leo-star / leo-math）公共参数：
 *  必须 version=3.140.1 + platform=android37，否则主域端点被 solar-encoder 拦（400/417）。 */
const MAIN_COMMON_QUERY = [
  ['platform', PK.exercise.platform],
  ['version', PK.exercise.version],
  ['vendor', PK.exercise.vendor],
  ['av', PK.exercise.av],
  ['deviceCategory', PK.exercise.deviceCategory],
  ['webviewVersion', PK.exercise.webviewVersion],
  ['whRatio', PK.exercise.whRatio],
  ['isBackground', PK.exercise.isBackground],
];
const MAIN_DOMAIN_PREFIXES = ['/leo-gateway', '/leo-profile', '/leo-auth', '/leo-star', '/leo-math', '/leo-reward', '/leo-account'];
const COMMON_QUERY = [
  ['platform', PK.commonQuery.platform],
  ['version', PK.commonQuery.version],
  ['vendor', PK.commonQuery.vendor],
  ['av', PK.commonQuery.av],
  ['deviceCategory', PK.commonQuery.deviceCategory],
  ['webviewVersion', PK.commonQuery.webviewVersion],
  ['whRatio', PK.commonQuery.whRatio],
  // 真机 PK 出题 URL 没有 isBackground（抓包逐字），故不补。
];

/** 风控头（真机抓包逐字）——**PK/H5 系**（`leo-game-pk`）用这套即可。 */
function riskHeaders() {
  return Object.assign(
    {
      'X-XYKS-REQ-TIMESTAMP': String(Date.now()),
    },
    PK.headers,
  );
}

/* --------------------- 主域「App 原生」请求头（417 关键） --------------------- */

/**
 * App 原生 UA：`Leo/<版本名> (<BRAND><MODEL>; Android <sdkInt>; Scale/<density>)`。
 * ⚠️ 不是 H5 的 Chrome UA：主域 417 风控会核对它，用 H5 UA 打 accounts/switch 会被拦成 417。
 */
function leoUserAgent() {
  const d = config.device;
  return 'Leo/' + PK.commonQuery.version +
    ' (' + d.brand + d.model + '; Android ' + d.sdk + '; Scale/' + d.scale + ')';
}

/** 20 位小写十六进制，形态同真机 `leo-client-trace-id`。 */
function randomTraceId() {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 20; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

/**
 * `default-namespace-sw8`：真机形态为
 * `b64("1")-b64(traceId)-b64("0")-0-<固定尾>`。
 * 尾部那几段是固定常量（真机逐字如此），照抄。
 */
function sw8Header(traceId) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  return b64('1') + '-' + b64(traceId) + '-' + b64('0') + '-0-X19PX1JfVF9f-UF9J-UF9F-SV9Q';
}

/**
 * 主域 App 原生请求头（对齐原版 HeaderInterceptor）。这是 417 的解药：
 * 缺 `x-shepherd-did` / `leo-client-trace-id` / `default-namespace-sw8` 时主域端点会 417。
 * 只给主域用；账号域（ape-api）不需要，加了反而干扰。
 * @param {object} [extra] 额外/覆盖的 header
 */
function mainDomainHeaders(extra) {
  const traceId = randomTraceId();
  const h = {
    'User-Agent': leoUserAgent(),
    Accept: 'application/json',
    'X-App-Version': PK.commonQuery.version,
    'X-Channel': 'official',
    'X-XYKS-REQ-TIMESTAMP': String(Date.now()),
    'X-XYKS-REQ-NETWORK-ENV': 'mobile',
    'x-shepherd-sessionid': '0',
    'leo-client-trace-id': traceId,
    'default-namespace-sw8': sw8Header(traceId),
  };
  // 没配 PK_SHEPHERD_DID 就不发这个头（空值反而可能被判异常）
  if (config.shepherdDid) h['x-shepherd-did'] = config.shepherdDid;
  return Object.assign(h, extra || {});
}

/**
 * 组装一个主域请求的完整 URL（含公共参数 + sign）。
 *
 * @param {string} urlPath   只含路径，如 `/leo-game-pk/android/math/pk/submit`
 * @param {object} params    业务参数（priority 最高，不会被覆盖）
 * @param {object} [opts]
 * @param {string} [opts.productId] 默认 PK.productIdDefault(611)
 * @param {string} [opts.appId]     仅 PK 端点需要（6）
 * @returns {string} 完整 https URL
 */
function buildUrl(urlPath, params = {}, opts = {}) {
  const q = new URLSearchParams();

  // _productId 必须放最前（原版真机 URL 顺序）；放到最后时 accounts/switch 直接 400。
  q.set('_productId', opts.productId || PK.productIdDefault);
  if (opts.appId) q.set('_appId', opts.appId);

  // 1) 公共参数：主域用 MAIN_COMMON_QUERY（android37 / 3.140.1），PK 等用 COMMON_QUERY
  const isMain = MAIN_DOMAIN_PREFIXES.some((pre) => String(urlPath).indexOf(pre) === 0);
  for (const [k, v] of (isMain ? MAIN_COMMON_QUERY : COMMON_QUERY)) q.set(k, v);

  // 3) 业务参数（最后放，可覆盖前面任何同名键 —— 调用方优先）
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    q.set(k, String(v));
  }

  // 4) sign —— 按 signMode 决定加不加（默认 off：PK 用不上，且它需要 arm64）
  const sign = maybeSign(urlPath);
  if (sign) q.set('sign', sign);

  return config.leoBase + urlPath + '?' + q.toString();
}

/**
 * 决定是否计算 sign：按端点判断「要不要签名 / 用哪套签名资产」。
 *  - PK v1（`/leo-game-pk/android/math/pk/match`）：不需要签名；
 *  - PK v2 与提交等新端点：需要签名，用 `variant:'pk'` 资产（套练习版会 417）；
 *  - 其余主域端点：沿用练习版资产。
 * @param {string} urlPath 只含路径
 * @returns {string|null} 32 位 hex 或 null
 */
function maybeSign(urlPath) {
  const mode = String(config.signMode || 'off').toLowerCase();
  if (mode === 'off') return null;

  const p = String(urlPath);
  if (p === '/leo-game-pk/android/math/pk/match') return null;   // v1 不需要签名

  const variant = p.indexOf('/leo-game-pk') === 0 ? 'pk' : 'exercise';
  try {
    return nativeLib.calcSign(p, { variant });
  } catch (e) {
    if (mode === 'on') throw e;
    return null;                       // auto：静默降级
  }
}

/* ------------------------------ PK 接口 ------------------------------ */

/** PK 端点统一带的固定参数。真机实测：只有 `_productId=611`，**没有 `_appId`**。 */
function pkOpts(extra = {}) {
  return Object.assign({ productId: PK.productIdPk }, extra);
}

/**
 * PK 出题用的 H5 WebView UA（真机抓包逐字）。
 * ⚠️ 与主域「App 原生」UA（`Leo/...`）不是一套：PK 出题由 H5 页面发起，用错 UA 会被判异常。
 */
const PK_WEBVIEW_UA =
  'Mozilla/5.0 (Linux; Android 15; DCO-AL00 Build/V417IR; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 Mobile Safari/537.36 ' +
  'YuanSouTiKouSuan/' + PK.commonQuery.version;

/** PK H5 请求头（真机抓包逐字）。 */
function pkH5Headers(refererPage) {
  return {
    'User-Agent': PK_WEBVIEW_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: config.leoBase,
    'X-Requested-With': 'com.fenbi.android.leo',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: config.leoBase + '/bh5/leo-web-oral-pk/' + (refererPage || 'exercise.html'),
  };
}

/**
 * 出题：`POST /leo-game-pk/android/math/pk/match?pointId=N`（明文 JSON）。
 * 不用 `match/v2`：v2 返回 arraybuffer 加密，服务端 solar-encoder 拦（417）。
 * @returns {Promise<{status:number, json:object|null, text:string, headers:object}>}
 */
async function pkMatch(jar, pointId, opts) {
  const path = '/leo-game-pk/android/math/pk/match';
  // version/platform/vendor 用 PK.commonQuery 的真机值（android35 / 3.143.1 / fenbi）。
  const url = buildUrl(path, { pointId: String(pointId) }, pkOpts());
  const r = await request({
    url,
    method: 'POST',
    jar,
    signal: opts && opts.signal,
    headers: pkH5Headers('exercise.html'),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text, headers: r.headers };
}

/**
 * 出题 v2：`POST /leo-game-pk/android/math/pk/match/v2?pointId=N`（加密响应）。
 * 请求 body 必须是**空**，传 {} 会被服务端判 400。
 * 解密链路：密文 --keystream XOR--> gzip 字节 --gunzip--> 明文 JSON。
 * @returns {Promise<{status:number, json:object|null, text:string, headers:object}>}
 */
async function pkMatchV2(jar, pointId, opts) {
  const path = '/leo-game-pk/android/math/pk/match/v2';
  // 业务参数在最前、公共参数在后、sign 夹中间（顺序不影响 sign，sign 只对 encodedPath 计算）。
  const url = buildUrl(path, { pointId: String(pointId), triggerPeakMatch: '0' }, pkOpts());
  const r = await request({
    url,
    method: 'POST',
    jar,
    signal: opts && opts.signal,
    rawBody: true,                       // 加密字节，别当 gzip 解码
    headers: pkH5Headers('exercise.html'),
  });
  const out = decodeEncryptedResponse(r.body);
  return {
    status: r.status,
    json: out ? safeJson(out.toString('utf8')) : safeJson(r.text),
    text: out ? out.toString('utf8') : r.text,
    headers: r.headers,
    encrypted: r.body,
  };
}

/**
 * 解密「加密响应」：密文 -> keystream XOR -> gunzip -> JSON 字节。
 * 与 pk-h5-proxy 的 decodeEncrypted 同一套逻辑，改动务必同步。
 * @param {Buffer} buf
 * @returns {Buffer|null} 明文；不是密文时返回 null
 */
function decodeEncryptedResponse(buf) {
  if (!buf || buf.length < 2) return null;
  if (buf[0] === 0x7b || buf[0] === 0x5b) return null;   // 已是 JSON
  if (buf[0] === 0x1f && buf[1] === 0x8b) return null;   // 真 gzip
  if (!keystream.available()) return null;
  let dec;
  try { dec = keystream.xorEncode(buf); } catch (e) { return null; }
  if (dec[0] === 0x1f && dec[1] === 0x8b) {
    try { return zlib.gunzipSync(dec); } catch (e) { return null; }
  }
  if (dec[0] === 0x7b) return dec;
  return null;
}

/**
 * 提交一局：`PUT /leo-game-pk/android/math/pk/submit`，body 为已加密密文。
 * 单独暴露这一层是因为加密会起 native 进程（80~250ms），调用方需在其间写日志。
 * @param {Buffer} cipher 已经过 `c = c(gzip(json))` 的密文
 * @returns {Promise<{status:number, text:string, headers:object}>}
 */
async function pkSubmitRaw(jar, cipher, opts) {
  const path = '/leo-game-pk/android/math/pk/submit';
  const url = buildUrl(path, {}, pkOpts());

  const r = await request({
    url,
    method: 'PUT',
    jar,
    body: cipher,
    signal: opts && opts.signal,
    headers: Object.assign(
      {
        'Content-Type': 'application/octet-stream',
        Referer: config.leoBase + '/bh5/leo-web-oral-pk/pk.html',
      },
      riskHeaders(),
    ),
  });
  return { status: r.status, text: r.text, headers: r.headers };
}

/**
 * 结算查询：`GET /leo-game-pk/android/math/pk/history/detail?pkIdStr=X`
 * 提交返回 200 只代表「服务端收下」，不代表已结算；提交成功后额外拉本接口
 * **以结算结果为准**判断这局是否真的算上（避免「日志成功、实际没结算」）。
 * @returns {Promise<{status:number, json:object|null, text:string}>}
 */
async function pkHistoryDetail(jar, pkIdStr, opts) {
  const path = '/leo-game-pk/android/math/pk/history/detail';
  const url = buildUrl(path, { pkIdStr: String(pkIdStr) }, pkOpts());
  const r = await request({
    url,
    method: 'GET',
    jar,
    signal: opts && opts.signal,
    headers: Object.assign(
      {
        Referer: config.leoBase + '/bh5/leo-web-oral-pk/result.html?pkIdStr=' + encodeURIComponent(pkIdStr),
      },
      riskHeaders(),
    ),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/**
 * 提交一局（便捷版）：明文 body → 加密 → 提交。
 *
 * body 流程：明文 JSON → gzip(level6,mtime0) → libContentEncoder → octet-stream。
 * 逐字节与真机一致（已实测）。
 *
 * @param {object} bodyObj 提交 body（结构见 pk-engine.buildSubmitBody）
 * @returns {Promise<{status:number, text:string, headers:object}>}
 */
async function pkSubmit(jar, bodyObj) {
  const plain = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  return pkSubmitRaw(jar, nativeLib.encodeSubmitBody(plain));
}

/** PK 首页（对局类型 + 分数）。明文 JSON。 */
async function pkHome(jar, grade) {
  const path = '/leo-game-pk/android/math/pk/home';
  const url = buildUrl(path, { grade: String(grade) }, pkOpts());
  const r = await request({
    url,
    method: 'GET',
    jar,
    headers: riskHeaders(),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text, headers: r.headers };
}

/* ---------------------------- 子账号接口 ---------------------------- */

/**
 * 子账号 ID 列表：`GET /leo-profile/api/user-infos/context`（**不需设备链**，稳 200）。
 *
 * @returns {Promise<{status:number, json:object|null, text:string}>}
 */
async function userInfosContext(jar) {
  const path = '/leo-profile/api/user-infos/context';
  const url = buildUrl(path, {}, { productId: '241' });
  const r = await request({ url, method: 'GET', jar, headers: mainDomainHeaders() });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/**
 * 子账号详情（名字/头像/年级）：`GET /leo-profile/android/user-infos/batchGet`。
 * ⚠️ 原版无参接口（按当前 cookie 返回）；需要设备链，可能 401/417，失败不致命。
 */
async function subAccountsBatchGet(jar) {
  const path = '/leo-profile/android/user-infos/batchGet';
  const url = buildUrl(path, {});
  const r = await request({ url, method: 'GET', jar, headers: mainDomainHeaders() });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/** 账号域：当前用户资料（昵称/头像/年级），**不需设备链**。 */
async function ytkUserProfile(jar) {
  const path = '/profile/android/user-info';
  const url = 'https://' + config.ytkHost + path;
  const r = await request({ url, method: 'GET', jar, headers: riskHeaders() });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/**
 * 切换到子账号：`POST /leo-gateway/android/accounts/switch`，`targetUserId`。
 * 成功后服务端下发新的 `userid` cookie，必须让 [CookieJar] 吸收，否则后续仍带旧身份。
 */
async function switchSubAccount(jar, targetUserId) {
  const path = '/leo-gateway/android/accounts/switch';
  const url = buildUrl(path, {}, {});
  const form = new URLSearchParams({ targetUserId: String(targetUserId) }).toString();
  const r = await request({
    url,
    method: 'POST',
    jar,
    body: form,
    headers: mainDomainHeaders({
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    }),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/* ---------------------------- 账号域：登录 ---------------------------- */

/**
 * 账号域请求的公共头：刻意不带主域公共参数（platform/vendor/sign…），
 * 登录接口在 ape-api，不吃 sign 也不需要设备链。
 */
function ytkHeaders(extra) {
  return Object.assign({ 'User-Agent': 'okhttp/4.9.2' }, extra || {});
}

/**
 * 发送短信验证码：`POST /verifier/android/sms`（form-urlencoded）。
 *
 * 三条实测事实（勿想当然改）：
 *  1. **`phone` 必须是 RSA 密文** —— 明文返回 403「验证码获取失败」；
 *  2. `YFD_U` 是可空 Query，**未登录时省略不报错**（匿名可发）；
 *  3. 成功 = HTTP 200 + `Content-Length: 0`（响应头 `x-yfd-service: fenbi-verifier`），
 *     没有 JSON 信封，别去解析 body。
 *
 * @param {Object|null} jar 可为 null（未登录时匿名发码）
 * @param {string} phoneEncrypted Base64 的 RSA 密文手机号
 */
async function ytkSmsVerify(jar, phoneEncrypted) {
  const body = new URLSearchParams({ phone: phoneEncrypted }).toString();
  const r = await request({
    url: config.ytkBase + '/verifier/android/sms',
    method: 'POST',
    jar: jar || undefined,
    body: body,
    headers: ytkHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
  });
  return { status: r.status, text: r.text, headers: r.headers };
}

/**
 * 短信验证码登录：`POST /accounts/android/safe/login`。
 * ⚠️ `phone` 与 `verification` 都是 RSA 密文（验证码也要加密，容易漏）；`autoRegister` 原版硬编码 true。
 * 成功响应是平铺账号对象（无 code/body 信封），并下发 sess/userid/g_sess/persistent cookie。
 */
async function ytkSmsLogin(jar, phoneEncrypted, verificationEncrypted, autoRegister) {
  const body = new URLSearchParams({
    phone: phoneEncrypted,
    verification: verificationEncrypted,
    autoRegister: autoRegister ? 'true' : 'false',
  }).toString();
  const r = await request({
    url: config.ytkBase + '/accounts/android/safe/login',
    method: 'POST',
    jar: jar,
    body: body,
    headers: ytkHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text, headers: r.headers };
}

/**
 * 密码登录：`POST /accounts/android/safe/login`。
 * ⚠️ 与手机号登录不同：`phone` 是明文、`password` 要 RSA 密文（明文密码→401）；不要把两者统一加密。
 * 不用主域网关版 `/leo-gateway/android/auth/password`：该接口明文/密文一律 401，拿不到语义化错误。
 */
async function ytkPasswordLogin(jar, phonePlain, passwordEncrypted) {
  const body = new URLSearchParams({
    phone: phonePlain,
    password: passwordEncrypted,
  }).toString();
  const r = await request({
    url: config.ytkBase + '/accounts/android/safe/login',
    method: 'POST',
    jar: jar,
    body: body,
    headers: ytkHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text, headers: r.headers };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

module.exports = {
  COMMON_QUERY,
  buildUrl,
  riskHeaders,
  leoUserAgent,
  mainDomainHeaders,
  sw8Header,
  randomTraceId,
  pkMatch,
  pkMatchV2,
  decodeEncryptedResponse,
  pkSubmitRaw,
  pkSubmit,
  pkHistoryDetail,
  pkHome,
  userInfosContext,
  subAccountsBatchGet,
  ytkUserProfile,
  switchSubAccount,
  ytkSmsVerify,
  ytkSmsLogin,
  ytkPasswordLogin,
  CookieJar,
};