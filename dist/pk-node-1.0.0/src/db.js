'use strict';
/**
 * 数据库层（Node 内置 `node:sqlite`，零外部依赖）。
 *
 * ## 设计要点
 *
 * - **单进程同步 API**：`node:sqlite` 是同步的，本项目是单机小服务，同步足够且代码简单。
 *   唯一要注意的是别在热路径里做全表扫描（都加了索引）。
 * - **用户口令**：`scrypt` + 每用户随机 salt（Node `crypto.scryptSync`）。
 *   不用 bcrypt/argon2 是为了零依赖；scrypt 本身是抗暴力破解的 KDF。
 * - **小猿 cookie 的存储**：整份 cookie 以 JSON 存 **明文**（`sub_accounts.cookies_json`）。
 *   这一点必须诚实说明：服务要拿它去请求小猿，本地又没密钥管理，
 *   所以「谁能读到这台机器的 db 文件，谁就能拿到 cookie」。
 *   缓解：默认只监听 `127.0.0.1`；管理后台可随时清空。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

let db = null;

/* ----------------------------- 口令哈希 ----------------------------- */

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  // N=16384 在手机上约 50ms，够用且不拖慢登录。
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expect = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(password, salt, expect.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(expect, got);
  } catch {
    return false;
  }
}

/* ------------------------------- 建表 ------------------------------- */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 本服务自己的账号（不是小猿账号）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- 会话（登录本服务后签发的 token）
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 小猿账号登录态（cookie，含设备链 sid/ks_*）
CREATE TABLE IF NOT EXISTS leo_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  cookies_json  TEXT    NOT NULL,          -- [{name,value,domain,path}]
  yfd_u         TEXT,                      -- userid cookie 的值
  grade         INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leo_accounts_user ON leo_accounts(user_id);

-- 子账号（从小猿上下文接口拉取，可随时刷新）
CREATE TABLE IF NOT EXISTS sub_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  leo_account_id INTEGER NOT NULL REFERENCES leo_accounts(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL,          -- 小猿的 userId
  nickname       TEXT,
  grade          INTEGER,
  avatar_url     TEXT,
  primary_user_id INTEGER,
  is_primary     INTEGER NOT NULL DEFAULT 0,
  raw_json       TEXT,
  updated_at     INTEGER NOT NULL,
  UNIQUE(leo_account_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sub_accounts_leo ON sub_accounts(leo_account_id);

-- 刷局任务
CREATE TABLE IF NOT EXISTS jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leo_account_id INTEGER NOT NULL REFERENCES leo_accounts(id) ON DELETE CASCADE,
  sub_user_id    INTEGER,
  status         TEXT    NOT NULL,          -- queued|running|done|failed|stopped
  config_json    TEXT    NOT NULL,          -- 刷局参数快照
  rounds_total   INTEGER NOT NULL,
  rounds_done    INTEGER NOT NULL DEFAULT 0,
  rounds_failed  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);

-- 每一轮的明细（日志 + 结果）
CREATE TABLE IF NOT EXISTS job_rounds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  round_no   INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  http_code  INTEGER,
  message    TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_rounds_job ON job_rounds(job_id, round_no);

-- 键值设置（默认刷局参数 / 穿透开关等）
CREATE TABLE IF NOT EXISTS kv (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(created_at DESC);
`;

function init() {
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  db = new DatabaseSync(config.dbFile);
  db.exec(SCHEMA);

  // 首次启动写入默认管理员（用户要求 admin/admin）。
  const row = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get('admin');
  if (!row || row.n === 0) {
    createUser(config.defaultAdminUser, config.defaultAdminPass, 'admin');
    console.log(
      `[db] 已创建默认管理员：${config.defaultAdminUser} / ${config.defaultAdminPass}（请尽快在管理后台改密）`,
    );
  }
  return db;
}

function get() {
  if (!db) throw new Error('db 未初始化');
  return db;
}

/* ------------------------------ 用户 ------------------------------ */

function createUser(username, password, role = 'user') {
  const now = Date.now();
  const info = get()
    .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)')
    .run(String(username), hashPassword(password), role, now);
  return Number(info.lastInsertRowid);
}

function findUserByName(username) {
  return get().prepare('SELECT * FROM users WHERE username = ?').get(String(username));
}

function findUserById(id) {
  return get().prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

function setUserPassword(id, password) {
  get().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), Number(id));
}

function setUserDisabled(id, disabled) {
  get().prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, Number(id));
}

function listUsers() {
  return get()
    .prepare('SELECT id, username, role, disabled, created_at, last_login_at FROM users ORDER BY id')
    .all();
}

function deleteUser(id) {
  get().prepare('DELETE FROM users WHERE id = ?').run(Number(id));
}

function touchLogin(id) {
  get().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), Number(id));
}

/* ------------------------------ 会话 ------------------------------ */

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  get()
    .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, Number(userId), now, now + config.sessionTtlMs);
  return token;
}

function getUserBySession(token) {
  if (!token) return null;
  const s = get().prepare('SELECT * FROM sessions WHERE token = ?').get(String(token));
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    get().prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
    return null;
  }
  return findUserById(s.user_id) || null;
}

function deleteSession(token) {
  get().prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
}

function purgeExpiredSessions() {
  get().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

/* --------------------------- 小猿账号 --------------------------- */

function addLeoAccount(userId, name, cookies, extra = {}) {
  const now = Date.now();
  const info = get()
    .prepare(
      `INSERT INTO leo_accounts (user_id, name, cookies_json, yfd_u, grade, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      Number(userId),
      String(name),
      JSON.stringify(cookies),
      extra.yfdU == null ? null : String(extra.yfdU),
      extra.grade == null ? null : Number(extra.grade),
      now,
      now,
    );
  return Number(info.lastInsertRowid);
}

function updateLeoAccount(id, name, cookies, extra = {}) {
  get()
    .prepare(
      `UPDATE leo_accounts SET name = ?, cookies_json = ?, yfd_u = COALESCE(?, yfd_u),
         grade = COALESCE(?, grade), updated_at = ? WHERE id = ?`,
    )
    .run(
      String(name),
      JSON.stringify(cookies),
      extra.yfdU == null ? null : String(extra.yfdU),
      extra.grade == null ? null : Number(extra.grade),
      Date.now(),
      Number(id),
    );
}

function listLeoAccounts(userId) {
  return get()
    .prepare('SELECT * FROM leo_accounts WHERE user_id = ? ORDER BY id DESC')
    .all(Number(userId));
}

function getLeoAccount(id) {
  return get().prepare('SELECT * FROM leo_accounts WHERE id = ?').get(Number(id));
}

function deleteLeoAccount(id) {
  get().prepare('DELETE FROM leo_accounts WHERE id = ?').run(Number(id));
}

/* ---------------------------- 子账号 ---------------------------- */

function replaceSubAccounts(leoAccountId, items) {
  const d = get();
  d.prepare('DELETE FROM sub_accounts WHERE leo_account_id = ?').run(Number(leoAccountId));
  const now = Date.now();
  const stmt = d.prepare(
    `INSERT INTO sub_accounts
       (leo_account_id, user_id, nickname, grade, avatar_url, primary_user_id, is_primary, raw_json, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const it of items) {
    stmt.run(
      Number(leoAccountId),
      Number(it.userId),
      it.nickname == null ? null : String(it.nickname),
      it.grade == null ? null : Number(it.grade),
      it.avatarUrl == null ? null : String(it.avatarUrl),
      it.primaryUserId == null ? null : Number(it.primaryUserId),
      it.isPrimary ? 1 : 0,
      it.raw == null ? null : JSON.stringify(it.raw),
      now,
    );
  }
  return items.length;
}

function listSubAccounts(leoAccountId) {
  return get()
    .prepare('SELECT * FROM sub_accounts WHERE leo_account_id = ? ORDER BY is_primary DESC, user_id')
    .all(Number(leoAccountId));
}

function getSubAccount(id) {
  return get().prepare('SELECT * FROM sub_accounts WHERE id = ?').get(Number(id));
}

/* ----------------------------- 任务 ----------------------------- */

function createJob(userId, leoAccountId, subUserId, cfg, roundsTotal) {
  const now = Date.now();
  // ⚠️ 参数顺序必须与列顺序严格一致：
  // (user_id, leo_account_id, sub_user_id, status, config_json, rounds_total, created_at)
  // 之前写成 ...subUserId, JSON.stringify(cfg), roundsTotal, 'queued', now 是错的 ——
  // 会把 config 写进 status、把 rounds_total 写成字符串 'queued'，
  // 结果任务循环条件 `i <= job.rounds_total` 永远为 false，一局都不跑就「完成」。
  const info = get()
    .prepare(
      `INSERT INTO jobs (user_id, leo_account_id, sub_user_id, status, config_json, rounds_total, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      Number(userId),
      Number(leoAccountId),
      subUserId == null ? null : Number(subUserId),
      'queued',
      JSON.stringify(cfg),
      Number(roundsTotal),
      now,
    );
  return Number(info.lastInsertRowid);
}

function setJobStatus(id, status, patch = {}) {
  const sets = ['status = ?'];
  const args = [status];
  if (patch.startedAt != null) { sets.push('started_at = ?'); args.push(patch.startedAt); }
  if (patch.finishedAt != null) { sets.push('finished_at = ?'); args.push(patch.finishedAt); }
  if (patch.roundsDone != null) { sets.push('rounds_done = ?'); args.push(patch.roundsDone); }
  if (patch.roundsFailed != null) { sets.push('rounds_failed = ?'); args.push(patch.roundsFailed); }
  if (patch.error !== undefined) { sets.push('error = ?'); args.push(patch.error); }
  args.push(Number(id));
  get().prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

function addJobRound(jobId, roundNo, ok, httpCode, message, detail) {
  get()
    .prepare(
      `INSERT INTO job_rounds (job_id, round_no, ok, http_code, message, detail, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      Number(jobId),
      Number(roundNo),
      ok ? 1 : 0,
      httpCode == null ? null : Number(httpCode),
      message == null ? null : String(message),
      detail == null ? null : String(detail).slice(0, 4000),
      Date.now(),
    );
}

function getJob(id) {
  return get().prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id));
}

function listJobs(userId, limit = 50) {
  return get()
    .prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(userId), Number(limit));
}

function listAllJobs(limit = 100) {
  return get()
    .prepare(
      `SELECT j.*, u.username FROM jobs j LEFT JOIN users u ON u.id = j.user_id
       ORDER BY j.id DESC LIMIT ?`,
    )
    .all(Number(limit));
}

function listJobRounds(jobId, limit = 200) {
  return get()
    .prepare('SELECT * FROM job_rounds WHERE job_id = ? ORDER BY round_no LIMIT ?')
    .all(Number(jobId), Number(limit));
}

/* ------------------------- 键值 / 审计 ------------------------- */

function kvGet(k, def = null) {
  const r = get().prepare('SELECT v FROM kv WHERE k = ?').get(String(k));
  return r ? r.v : def;
}

function kvSet(k, v) {
  get()
    .prepare(
      `INSERT INTO kv (k, v, updated_at) VALUES (?,?,?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    )
    .run(String(k), String(v), Date.now());
}

function audit(userId, action, detail, ip) {
  get()
    .prepare('INSERT INTO audit (user_id, action, detail, ip, created_at) VALUES (?,?,?,?,?)')
    .run(
      userId == null ? null : Number(userId),
      String(action),
      detail == null ? null : String(detail).slice(0, 1000),
      ip == null ? null : String(ip),
      Date.now(),
    );
}

function listAudit(limit = 200) {
  return get()
    .prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
    .all(Number(limit));
}

module.exports = {
  init,
  get,
  hashPassword,
  verifyPassword,
  createUser,
  findUserByName,
  findUserById,
  setUserPassword,
  setUserDisabled,
  listUsers,
  deleteUser,
  touchLogin,
  createSession,
  getUserBySession,
  deleteSession,
  purgeExpiredSessions,
  addLeoAccount,
  updateLeoAccount,
  listLeoAccounts,
  getLeoAccount,
  deleteLeoAccount,
  replaceSubAccounts,
  listSubAccounts,
  getSubAccount,
  createJob,
  setJobStatus,
  addJobRound,
  getJob,
  listJobs,
  listAllJobs,
  listJobRounds,
  kvGet,
  kvSet,
  audit,
  listAudit,
};