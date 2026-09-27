'use strict';
// 小猿口算协议层：URL 组装（公共参数 + sign）+ PK 接口调用 + 子账号接口。
//
// ## 为什么公共参数要「逐参数补齐」而不是整体覆盖
//
// PK 端点要求 `_productId=631&_appId=6`，其余主域端点要 `_productId=611`。
// 调用方显式给的参数**必须原样保留**，缺的才补默认值 —— 整体覆盖会把
// 631 冲成 611，PK 直接 401（SolarAuthFilter）。这是原项目的真实教训。
//
// ## sign 的口径
//
// `sign` 的输入是 **encodedPath（不含 query）**，且在 URL 完全定稿后计算。
// 本项目里路径都是写死的常量，因此 sign 可在发请求前算好。

const { URL, URLSearchParams } = require('node:url');
const { config, PK } = require('./config');
const { request, CookieJar } = require('./http');
const nativeLib = require('./native');

/** 默认公共参数（顺序固定，便于比对真机抓包）。 */
const COMMON_QUERY = [
  ['platform', PK.commonQuery.platform],
  ['version', PK.commonQuery.version],
  ['vendor', PK.commonQuery.vendor],
  ['av', PK.commonQuery.av],
  ['deviceCategory', PK.commonQuery.deviceCategory],
  ['webviewVersion', PK.commonQuery.webviewVersion],
  ['whRatio', PK.commonQuery.whRatio],
  ['isBackground', PK.commonQuery.isBackground],
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
 *
 * ⚠️ 这不是 H5 的 Chrome UA。主域（`leo-gateway` / `leo-profile`）的 417 风控
 * 会核对它 —— 用 H5 UA 打 `accounts/switch` 会直接被 solar-encoder 拦成
 * `417 No message available`（实测）。
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
 * 主域 App 原生请求头（对齐原版 `HeaderInterceptor`）。
 *
 * 这一组是 **417 的解药**：缺 `x-shepherd-did` / `leo-client-trace-id` /
 * `default-namespace-sw8` 时，主域端点（尤其 `accounts/switch`）会 417。
 *
 * 只给**主域**（`xyks.yuanfudao.com`）用；账号域（ape-api）实测不需要，
 * 加了反而可能干扰 —— 与公共参数同一纪律。
 *
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

  // 1) 公共参数（固定顺序，先放）
  for (const [k, v] of COMMON_QUERY) q.set(k, v);

  // 2) 产品号 / appId
  q.set('_productId', opts.productId || PK.productIdDefault);
  if (opts.appId) q.set('_appId', opts.appId);

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
 * 按 [config.signMode] 决定是否计算 sign。
 *
 * 计算需要 arm64 原生库（`libRequestEncoder` 的 T 段随分钟变化，已确认无法纯 JS 复现）。
 * 因此：
 *  - `off`（默认）：直接返回 null，**完全不碰原生库** → x86/Windows 可用；
 *  - `auto`：能算就算，算不了返回 null（不抛）；
 *  - `on`：算不出来就抛错（明确失败，而不是静默降级）。
 *
 * @param {string} urlPath 只含路径
 * @returns {string|null} 32 位 hex 或 null
 */
function maybeSign(urlPath) {
  const mode = String(config.signMode || 'off').toLowerCase();
  if (mode === 'off') return null;

  try {
    return nativeLib.calcSign(urlPath);
  } catch (e) {
    if (mode === 'on') throw e;
    return null;                       // auto：静默降级
  }
}

/* ------------------------------ PK 接口 ------------------------------ */

/** PK 端点统一带的固定参数。 */
function pkOpts(extra = {}) {
  return Object.assign({ productId: PK.productIdPk, appId: PK.appIdPk }, extra);
}

/**
 * 出题：`POST /leo-game-pk/android/math/pk/match?pointId=N`（明文 JSON）。
 *
 * 为什么不用 `match/v2`：v2 返回 arraybuffer 加密，服务端 solar-encoder 拦（417）；
 * 旧版明文 match 返回 200 明文 JSON（已在本地 Python 跑通）。
 *
 * @returns {Promise<{status:number, json:object|null, text:string, headers:object}>}
 */
async function pkMatch(jar, pointId, opts) {
  const path = '/leo-game-pk/android/math/pk/match';
  const url = buildUrl(path, { pointId: String(pointId) }, pkOpts());
  const r = await request({
    url,
    method: 'POST',
    jar,
    signal: opts && opts.signal,
    headers: Object.assign(
      {
        'Content-Type': 'application/json',
        Referer: config.leoBase + '/bh5/leo-web-oral-pk/pk.html',
      },
      riskHeaders(),
    ),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text, headers: r.headers };
}

/**
 * 提交一局：`PUT /leo-game-pk/android/math/pk/submit`，body 为**已加密的密文**。
 *
 * 为什么要单独暴露这一层：加密会起 native 进程（80~250ms），调用方
 * （pk-engine）需要在这两步之间往日志里写「开始加密 / 加密完成」，
 * 否则用户只看到「提交」一闪而过、以为没在跑。
 *
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
 *
 * ⚠️ 原版是**无参**接口（按当前 cookie 返回列表）；需要设备链，可能 401/417。
 * 失败不致命 —— 上层会退化显示 `账号 {uid}`。
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
 *
 * 成功后服务端会下发新的 `userid` cookie —— 必须让 [CookieJar] 吸收，
 * 否则后续请求仍带旧身份。
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
 * 账号域请求的公共头。
 *
 * **这里刻意不带主域那套公共参数（platform/vendor/sign…）**：
 * 登录接口在 `ape-api.yuanfudao.com`，不吃主域的 sign，也不需要设备链
 * （实测发码、密码登录都是裸 form 就通）。
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
 *
 * 参数口径（逐行来自原版 `wo/d.smali`，**不是**注解推断）：
 *  - `phone` **RSA 密文**
 *  - `verification` **RSA 密文**（验证码也要加密，容易漏）
 *  - `autoRegister` 原版硬编码 `true`
 *
 * 成功响应是**平铺账号对象**（没有 code/body 信封），并下发
 * `sess` / `userid` / `g_sess` / `persistent` cookie —— 由 [CookieJar] 自动收下。
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
 *
 * ⚠️ 与手机号不同，这里 **`phone` 是明文**、**`password` 要 RSA 密文**
 * （实测：明文密码 → 401「密码错误」；RSA 密文 → 200 并下发 cookie）。
 * 不要把两者统一加密，这是服务端的实际口径。
 *
 * 为什么不用主域网关版 `/leo-gateway/android/auth/password`：实测该接口
 * 无论明文还是密文一律 401 `unauthorized`，拿不到任何语义化错误。
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
  pkSubmitRaw,
  pkSubmit,
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