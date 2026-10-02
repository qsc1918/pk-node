'use strict';
// 本服务（pk-node）自身的账号服务：注册 / 登录 / 会话 / 改密。
//
// 与「小猿账号」是两回事：
//   - 本服务账号 = 谁能登进这个网页（users 表）；
//   - 小猿账号 = 用哪个小猿身份去刷局（leo_accounts 表，一个本服务用户可绑多个）。
//
// 默认管理员 admin/admin 在 db.init() 时写入。

const db = require('../db');
const { config } = require('../config');

/** 用户名规则：3~32 位，字母数字下划线点横线。 */
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

/** 密码最短长度。默认管理员是 admin/admin，但自注册用户要求长一点。 */
const MIN_PASSWORD_LEN = 6;

/**
 * 注册。
 *
 * @returns {{ok:boolean, id?:number, message?:string}}
 */
function register(username, password) {
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!USERNAME_RE.test(u)) {
    return { ok: false, message: '用户名需 3~32 位字母/数字/下划线/点/横线' };
  }
  if (p.length < MIN_PASSWORD_LEN) {
    return { ok: false, message: `密码至少 ${MIN_PASSWORD_LEN} 位` };
  }
  if (db.findUserByName(u)) return { ok: false, message: '用户名已存在' };
  const id = db.createUser(u, p, 'user');
  return { ok: true, id: id };
}

/**
 * 登录，成功则签发会话 token。
 *
 * @returns {{ok:boolean, token?:string, user?:object, message?:string}}
 */
function login(username, password) {
  const u = db.findUserByName(String(username || '').trim());
  // 不区分「用户不存在」与「密码错误」，避免用户名枚举。
  if (!u) return { ok: false, message: '用户名或密码错误' };
  if (u.disabled) return { ok: false, message: '该账号已被禁用' };
  if (!db.verifyPassword(String(password || ''), u.password_hash)) {
    return { ok: false, message: '用户名或密码错误' };
  }
  const token = db.createSession(u.id);
  db.touchLogin(u.id);
  return {
    ok: true,
    token: token,
    user: { id: u.id, username: u.username, role: u.role },
  };
}

/** 登出（删除会话）。 */
function logout(token) {
  if (token) db.deleteSession(token);
}

/**
 * 从 cookie 里解析当前登录用户。
 * 已禁用账号立即失效（强制退出）：发现 disabled 就删掉该会话返回 null，
 * 浏览器所有 /api/* 立刻 401，重新登录也会被 login() 挡住。
 */
function currentUser(cookieHeader) {
  const token = readSessionCookie(cookieHeader);
  if (!token) return null;
  const u = db.getUserBySession(token);
  if (!u) return null;
  if (u.disabled) {
    try { db.deleteSession(token); } catch (e) { /* 删不掉也不影响本次拒绝 */ }
    return null;
  }
  return u;
}

/** 生成登录成功要写的 Set-Cookie 头。 */
function sessionSetCookie(token) {
  const maxAge = Math.floor(config.sessionTtlMs / 1000);
  return `${config.sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/** 生成登出要写的 Set-Cookie 头（立刻过期）。 */
function clearSetCookie() {
  return `${config.sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 从 Cookie 头里取本服务会话 token。 */
function readSessionCookie(cookieHeader) {
  const raw = String(cookieHeader || '');
  for (const part of raw.split(';')) {
    const s = part.trim();
    const i = s.indexOf('=');
    if (i <= 0) continue;
    if (s.slice(0, i).trim() === config.sessionCookie) return s.slice(i + 1).trim();
  }
  return null;
}

/**
 * 改密（需校验旧密码；管理员给自己改密也走这里）。
 *
 * @returns {{ok:boolean, message?:string}}
 */
function changePassword(userId, oldPassword, newPassword) {
  const u = db.findUserById(userId);
  if (!u) return { ok: false, message: '用户不存在' };
  if (!db.verifyPassword(String(oldPassword || ''), u.password_hash)) {
    return { ok: false, message: '原密码错误' };
  }
  const np = String(newPassword || '');
  if (np.length < MIN_PASSWORD_LEN) return { ok: false, message: `新密码至少 ${MIN_PASSWORD_LEN} 位` };
  db.setUserPassword(u.id, np);
  return { ok: true };
}

module.exports = {
  USERNAME_RE,
  MIN_PASSWORD_LEN,
  register,
  login,
  logout,
  currentUser,
  sessionSetCookie,
  clearSetCookie,
  readSessionCookie,
  changePassword,
};