'use strict';
// 小猿登录流程：短信验证码 / 密码，两条路径最终都落到「导入 leo_accounts」。
//
// ## 为什么不复用 HTTP 层的 CookieJar 长期保存
//
// 登录分两步（发码 → 交码），两步之间必须共用同一个 cookie jar
// （服务端可能下发风控/会话 cookie）。但那是**中间态**，不该写库。
// 所以这里用一个内存 Map 存「登录会话」：进程重启即丢，无残留、无隐私负担。
//
// ## 与「导入 cookie」的关系
//
// 三条入口（短信 / 密码 / 粘贴 cookie）**最终都调同一个落库函数**
// `persistAccount()` —— 保证导入后行为完全一致（探活、拉子账号、存 cookie）。

const leo = require('../leo');
const rsa = require('../crypto-rsa');
const { importAccount } = require('./leo-accounts');

/** 登录会话有效期：15 分钟（够输验证码）。 */
const LOGIN_TTL_MS = 15 * 60 * 1000;

/** token → { appUserId, phone, jar, createdAt } */
const sessions = new Map();

let seq = 0;
function newToken() {
  seq += 1;
  return 'lg_' + Date.now().toString(36) + '_' + seq + '_' + Math.random().toString(36).slice(2, 10);
}

function purge() {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.createdAt > LOGIN_TTL_MS) sessions.delete(k);
  }
}

/**
 * 取（或新建）一个登录会话。
 *
 * 发码与交码必须用**同一个** jar：某些风控 cookie 是发码时下发的，
 * 交码时不带上就可能被判「非同一来源」。
 */
function ensureSession(token, appUserId, phone) {
  purge();
  const existing = token ? sessions.get(String(token)) : null;
  if (existing) {
    // 同一会话换手机号重发时，必须更新 phone —— 否则交码时会用旧号登录，
    // 出现「发给 A 的验证码却拿去登 B」这种诡异失败。
    if (phone && existing.phone !== phone) existing.phone = phone;
    existing.createdAt = Date.now();
    return String(token);
  }
  const t = newToken();
  sessions.set(t, {
    appUserId: appUserId,
    phone: phone || null,
    jar: new leo.CookieJar([]),
    createdAt: Date.now(),
  });
  return t;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(String(token));
  if (!s) return null;
  if (Date.now() - s.createdAt > LOGIN_TTL_MS) {
    sessions.delete(String(token));
    return null;
  }
  return s;
}

function dropSession(token) {
  if (token) sessions.delete(String(token));
}

/* ---------------------------- 短信验证码 ---------------------------- */

/**
 * 发送短信验证码。
 *
 * ⚠️ 服务端语义（实测）：
 *  - **HTTP 200 + 空体** = 已发出；
 *  - **HTTP 403 + `{"message":"已发送短信验证码"}`** = 验证码此前已发、正在冷却，
 *    **不是失败**，应告诉用户「已发送，请稍候再试」，不要报错吓人；
 *  - HTTP 403 + `{"message":"验证码获取失败"}` = phone 没加密或号码有问题。
 *
 * @returns {Promise<{ok:boolean, token?:string, status:number, message:string, alreadySent?:boolean}>}
 */
async function sendSmsCode(o) {
  const phone = String(o.phone || '').trim();
  if (!rsa.isValidPhone(phone)) {
    return { ok: false, status: 0, message: '手机号格式不对（应为 11 位大陆号码）' };
  }

  const token = ensureSession(o.token, o.appUserId, phone);
  const s = getSession(token);

  let r;
  try {
    r = await leo.ytkSmsVerify(s.jar, rsa.encrypt(phone));
  } catch (e) {
    return { ok: false, token: token, status: 0, message: '网络失败：' + e.message };
  }

  if (r.status === 200) {
    return { ok: true, token: token, status: 200, message: '验证码已发送，请查收短信' };
  }

  const body = safeJson(r.text);
  const msg = (body && body.message) || ('HTTP ' + r.status);
  // 冷却态的 403 语义上等同「已发出」，单独标出来让前端提示更友好
  if (/已发送/.test(msg)) {
    return { ok: true, token: token, status: r.status, message: '验证码此前已发送（服务端冷却中），请直接用收到的验证码', alreadySent: true };
  }
  return { ok: false, token: token, status: r.status, message: msg };
}

/**
 * 提交验证码完成登录，并直接把账号导入库。
 *
 * 参数口径（逐行来自原版 `wo/d.smali`）：
 * `phone` 与 `verification` **都传 RSA 密文**，`autoRegister` 硬编码 `true`。
 *
 * @returns {Promise<{ok:boolean, message:string, accountId?:number, subs?:number}>}
 */
async function submitSmsCode(o) {
  const s = getSession(o.token);
  if (!s) return { ok: false, message: '登录会话已过期，请重新获取验证码' };
  if (!s.phone) return { ok: false, message: '登录会话缺少手机号，请重新获取验证码' };

  const code = String(o.code || '').trim();
  if (!rsa.isValidCode(code)) return { ok: false, message: '验证码格式不对' };

  let r;
  try {
    r = await leo.ytkSmsLogin(s.jar, rsa.encrypt(s.phone), rsa.encrypt(code), true);
  } catch (e) {
    return { ok: false, message: '网络失败：' + e.message };
  }

  if (r.status !== 200 || !r.json) {
    const body = r.json || safeJson(r.text);
    return { ok: false, message: (body && body.message) || ('登录失败 HTTP ' + r.status) };
  }

  const res = await persistAccount({
    appUserId: s.appUserId,
    name: o.name,
    jar: s.jar,
    phone: s.phone,
    account: r.json,
  });
  if (res.ok) dropSession(o.token);
  return res;
}

/* ------------------------------ 密码登录 ------------------------------ */

/**
 * 密码登录并导入库。
 *
 * ⚠️ 口径与短信不同：`phone` **明文**、`password` **RSA 密文**。
 * 实测明文密码 → `401 {"message":"密码错误"}`，密文才对。
 *
 * @returns {Promise<{ok:boolean, message:string, accountId?:number, subs?:number}>}
 */
async function submitPassword(o) {
  const phone = String(o.phone || '').trim();
  const password = String(o.password || '');
  if (!rsa.isValidPhone(phone)) return { ok: false, message: '手机号格式不对（应为 11 位大陆号码）' };
  if (password.length < 4) return { ok: false, message: '请输入密码' };

  const jar = new leo.CookieJar([]);
  let r;
  try {
    r = await leo.ytkPasswordLogin(jar, phone, rsa.encrypt(password));
  } catch (e) {
    return { ok: false, message: '网络失败：' + e.message };
  }

  if (r.status !== 200 || !r.json) {
    const body = r.json || safeJson(r.text);
    return { ok: false, message: (body && body.message) || ('登录失败 HTTP ' + r.status) };
  }

  return persistAccount({
    appUserId: o.appUserId,
    name: o.name,
    jar: jar,
    phone: phone,
    account: r.json,
  });
}

/* ---------------------------- 落库（三入口共用） ---------------------------- */

/**
 * 把一次成功登录的 cookie jar 变成库里的 leo 账号。
 *
 * 复用 `leo-accounts.importAccount` 的那套（探活 + 拉子账号 + 写库），
 * 保证「登录进来的账号」与「粘贴 cookie 进来的账号」完全等价。
 *
 * 做法：把 jar 序列化成 cookie 串，交给 importAccount 走一遍标准流程 ——
 * 避免两份实现漂移。
 */
async function persistAccount(o) {
  const cookies = o.jar.toJSON();
  if (cookies.length === 0) {
    return { ok: false, message: '登录成功但服务端未下发 cookie，无法继续（可能被风控拦截）' };
  }

  // 用「name=value; name=value」形态喂给标准导入流程
  const cookieText = cookies.map((c) => c.name + '=' + c.value).join('; ');

  const name = String(o.name || '').trim() ||
    (o.account && o.account.phone ? ('小猿 ' + o.account.phone) : '小猿账号');

  const res = await importAccount({
    appUserId: o.appUserId,
    name: name,
    cookieText: cookieText,
  });

  if (!res.ok) return { ok: false, message: '登录成功但导入失败：' + res.message };

  return {
    ok: true,
    accountId: res.id,
    subs: res.subs,
    subList: res.subList,
    yfdU: res.yfdU,
    grade: res.grade,
    message: '登录成功，已导入' + (res.subs ? '（发现 ' + res.subs + ' 个子账号）' : ''),
  };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

module.exports = {
  LOGIN_TTL_MS,
  sendSmsCode,
  submitSmsCode,
  submitPassword,
  getSession,
  dropSession,
};