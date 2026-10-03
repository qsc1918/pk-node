'use strict';
/**
 * 数据库层（Node 内置 node:sqlite，零外部依赖）。
 * - 单进程同步 API（别在热路径全表扫描，已加索引）。
 * - 用户口令：scrypt + 每用户随机 salt（零依赖，抗暴力破解）。
 * - 小猿 cookie：`leo_accounts.cookies_json` 每个 value 都加密（AES-256-GCM，见 cookiecrypt）；
 *   name/domain/path 明文便于「只列 cookie 名」。密钥来自 PK_SECRET 或 data/secret.key（0600）。
 *   => 光拿 db 文件打不开登录态与设备链，要同时拿密钥文件。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const cookiecrypt = require('./cookiecrypt');
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
--   device_chain_id 指「这个账号固定用池里哪一份设备链」；NULL = 不指定（_auto：池里随机挑一份补齐）。
--   导入时若粘贴内容自带 ks_*，会自动把这份收进池并绑到该账号上（见 leo-accounts.applyDeviceChain）。
CREATE TABLE IF NOT EXISTS leo_accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  cookies_json    TEXT    NOT NULL,          -- [{name,value,domain,path}]
  yfd_u           TEXT,                      -- userid cookie 的值
  grade           INTEGER,
  device_chain_id INTEGER,                   -- device_chains.id（NULL=自动挑一份）
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leo_accounts_user ON leo_accounts(user_id);
-- 注：idx_leo_accounts_chain 依赖 device_chain_id，必须等 init() 里的 ALTER 先跑完，
-- 否则老库上整段 SCHEMA 会在建索引这句就炸（见 init）。

-- 设备链池：多份 ks_*（同一设备可来自不同 App 账号），登录账号自动挑一份补齐。
--   value 同样加密存储（见 cookiecrypt）；label 只是给人看的备注。
CREATE TABLE IF NOT EXISTS device_chains (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT    NOT NULL DEFAULT '设备链',
  cookies_json TEXT  NOT NULL,          -- [{name,value,domain,path}]（value 加密）
  device_id  TEXT,                      -- ks_deviceid（明文，便于识别/去重）
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

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

/**
 * 给老库补列（CREATE TABLE 对已有表不生效，必须 ALTER）。
 * 幂等：已存在同名列时直接跳过。
 */
function ensureColumn(table, column, ddl) {
  const cols = get().prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) get().exec(ddl);
}

function init() {
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  db = new DatabaseSync(config.dbFile);
  db.exec(SCHEMA);

  // 老库补列：账号 → 设备链绑定（v1.8.1 新增；老库没有这一列）
  ensureColumn('leo_accounts', 'device_chain_id',
    'ALTER TABLE leo_accounts ADD COLUMN device_chain_id INTEGER');
  // 补列之后才能建依赖它的索引（放前面会让老库上 SCHEMA 直接失败）
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_leo_accounts_chain ON leo_accounts(device_chain_id)');
  } catch (e) { /* 索引重复/不支持则忽略 */ }

  // 启动即把历史明文 cookie 迁移为加密（幂等，已加密的会跳过）
  try {
    const m = migrateCookieEncryption();
    if (m.reEncrypted > 0) {
      // VACUUM：把旧明文页从 db / WAL 里彻底清掉（否则 checkpoint 前明文还在）
      try { db.exec('VACUUM'); } catch (e) { /* 忽略 */ }
      console.log(`[db] cookie 加密迁移：${m.reEncrypted}/${m.scanned} 条已加密（已 VACUUM 清除旧明文页）`);
    }
  } catch (e) {
    console.warn('[db] cookie 加密迁移失败（不影响启动）：' + e.message);
  }

  // 首次启动写入默认管理员。
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

/** 管理员人数（用于「不能删掉最后一个管理员」的保护）。 */
function countAdmins() {
  const r = get().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get();
  return Number(r && r.n) || 0;
}

/** 某用户名下的小猿账号数（删除账号前提示用）。 */
function countLeoAccountsOfUser(userId) {
  const r = get().prepare('SELECT COUNT(*) AS n FROM leo_accounts WHERE user_id = ?').get(Number(userId));
  return Number(r && r.n) || 0;
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

/**
 * 清掉某用户的全部会话 —— 即「强制退出登录」。
 * 管理员点「禁用」时必须调它：disabled 只在登录时检查，已存在的会话不受影响，否则禁用后仍能开任务。
 */
function deleteSessionsByUser(userId) {
  const info = get().prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(userId));
  return Number(info.changes) || 0;
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
      JSON.stringify(cookiecrypt.encryptItems(cookies)),
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
      JSON.stringify(cookiecrypt.encryptItems(cookies)),
      extra.yfdU == null ? null : String(extra.yfdU),
      extra.grade == null ? null : Number(extra.grade),
      Date.now(),
      Number(id),
    );
}

/** 把一行 leo_accounts 的 cookies_json 解密成明文 JSON 文本（对上层透明）。 */
function decryptAccountRow(row) {
  if (!row) return row;
  let items = null;
  try { items = JSON.parse(row.cookies_json); } catch (e) { return row; }
  const plain = cookiecrypt.decryptItems(items);
  return Object.assign({}, row, { cookies_json: JSON.stringify(plain) });
}
function listLeoAccounts(userId) {
  return get()
    .prepare('SELECT * FROM leo_accounts WHERE user_id = ? ORDER BY id DESC')
    .all(Number(userId)).map(decryptAccountRow);
}

function getLeoAccount(id) {
  return decryptAccountRow(get().prepare('SELECT * FROM leo_accounts WHERE id = ?').get(Number(id)));
}

function deleteLeoAccount(id) {
  get().prepare('DELETE FROM leo_accounts WHERE id = ?').run(Number(id));
}

/**
 * 把历史遗留的**明文** cookie 迁移为加密存储（幂等：已加密的会跳过）。
 *
 * @returns {{scanned:number, reEncrypted:number}}
 */
function migrateCookieEncryption() {
  const rows = get().prepare('SELECT id, cookies_json FROM leo_accounts').all();
  let re = 0;
  const upd = get().prepare('UPDATE leo_accounts SET cookies_json = ?, updated_at = ? WHERE id = ?');
  for (const row of rows) {
    let items = null;
    try { items = JSON.parse(row.cookies_json); } catch (e) { continue; }
    if (!Array.isArray(items)) continue;
    const plainCount = items.filter((c) => !String(c.value == null ? '' : c.value).startsWith(cookiecrypt.PREFIX)).length;
    if (plainCount === 0) continue;                    // 全是密文 → 跳过
    const enc = cookiecrypt.encryptItems(items);
    upd.run(JSON.stringify(enc), Date.now(), row.id);
    re++;
  }
  // 设备链池同样处理
  const prows = get().prepare('SELECT id, cookies_json FROM device_chains').all();
  const pupd = get().prepare('UPDATE device_chains SET cookies_json = ?, updated_at = ? WHERE id = ?');
  for (const row of prows) {
    let items = null;
    try { items = JSON.parse(row.cookies_json); } catch (e) { continue; }
    if (!Array.isArray(items)) continue;
    const plainCount = items.filter((c) => !String(c.value == null ? '' : c.value).startsWith(cookiecrypt.PREFIX)).length;
    if (plainCount === 0) continue;
    pupd.run(JSON.stringify(cookiecrypt.encryptItems(items)), Date.now(), row.id);
    re++;
  }
  return { scanned: rows.length + prows.length, reEncrypted: re };
}

/* --------------------------- 设备链池 --------------------------- */
/** 新增一份设备链。 */
function addDeviceChain(label, cookies, extra = {}) {
  const now = Date.now();
  const info = get()
    .prepare(
      `INSERT INTO device_chains (label, cookies_json, device_id, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      String(label || '设备链'),
      JSON.stringify(cookiecrypt.encryptItems(cookies)),
      extra.deviceId == null ? null : String(extra.deviceId),
      extra.enabled === 0 ? 0 : 1,
      now,
      now,
    );
  return Number(info.lastInsertRowid);
}

/** 设备链池（已解密，可直接用）。 */
function listDeviceChains(onlyEnabled) {
  const rows = onlyEnabled
    ? get().prepare('SELECT * FROM device_chains WHERE enabled = 1 ORDER BY id ASC').all()
    : get().prepare('SELECT * FROM device_chains ORDER BY id ASC').all();
  return rows.map((row) => {
    let items = [];
    try { items = JSON.parse(row.cookies_json); } catch (e) { items = []; }
    return Object.assign({}, row, { cookies: cookiecrypt.decryptItems(items) });
  });
}

function getDeviceChain(id) {
  const row = get().prepare('SELECT * FROM device_chains WHERE id = ?').get(Number(id));
  if (!row) return null;
  let items = [];
  try { items = JSON.parse(row.cookies_json); } catch (e) { items = []; }
  return Object.assign({}, row, { cookies: cookiecrypt.decryptItems(items) });
}

function deleteDeviceChain(id) {
  const cid = Number(id);
  get().prepare('DELETE FROM device_chains WHERE id = ?').run(cid);
  // 原来绑在它身上的账号退回「自动」（不指定），避免绑定指向已消失的行
  get().prepare('UPDATE leo_accounts SET device_chain_id = NULL WHERE device_chain_id = ?')
    .run(cid);
}

/**
 * 设置某账号「固定使用哪份设备链」。
 *
 * @param {number} leoId  小猿账号 id
 * @param {number|null} chainId 设备链 id；null/''/'auto' 表示「不指定（自动轮换）」
 * @throws {Error} 设备链不存在时抛错（让上层返回 400，别悄悄绑成脏 id）
 */
function setLeoAccountChain(leoId, chainId) {
  const cid = chainId === null || chainId === undefined || chainId === '' || chainId === 'auto' || chainId === 'null'
    ? null
    : Number(chainId);
  if (cid != null) {
    const row = get().prepare('SELECT id FROM device_chains WHERE id = ?').get(cid);
    if (!row) throw new Error('设备链不存在：' + cid);
  }
  get()
    .prepare('UPDATE leo_accounts SET device_chain_id = ?, updated_at = ? WHERE id = ?')
    .run(cid, Date.now(), Number(leoId));
  return cid;
}

/** 取某账号当前绑定的设备链 id（未绑定返回 null）。 */
function getLeoAccountChainId(leoId) {
  const row = get().prepare('SELECT device_chain_id FROM leo_accounts WHERE id = ?').get(Number(leoId));
  if (!row) return null;
  return row.device_chain_id == null ? null : Number(row.device_chain_id);
}

/** 每份设备链被几个账号指定使用（喂给 UI 显示「被 N 个账号使用」）。 */
function chainUsageMap() {
  const rows = get()
    .prepare('SELECT device_chain_id, COUNT(*) AS n FROM leo_accounts WHERE device_chain_id IS NOT NULL GROUP BY device_chain_id')
    .all();
  const m = {};
  for (const r of rows) m[String(r.device_chain_id)] = Number(r.n);
  return m;
}

/** 按 ks_deviceid 去重（已存在则更新 value，返回 {id, created}）。 */
function upsertDeviceChain(label, cookies, deviceId) {
  if (deviceId) {
    const row = get().prepare('SELECT id FROM device_chains WHERE device_id = ?').get(String(deviceId));
    if (row) {
      get().prepare('UPDATE device_chains SET label = ?, cookies_json = ?, updated_at = ? WHERE id = ?')
        .run(String(label || '设备链'), JSON.stringify(cookiecrypt.encryptItems(cookies)), Date.now(), row.id);
      return { id: row.id, created: false };
    }
  }
  return { id: addDeviceChain(label, cookies, { deviceId: deviceId }), created: true };
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
  // 顺序错会把 config 写进 status、rounds_total 写成字符串，导致循环条件恒 false。
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
  // 用 `!== undefined` 判断，使「继续任务」能传 finished_at = null 显式清空
  // （否则续跑任务带着上次结束时间，UI 像「已结束却还在跑」）。
  if (patch.finishedAt !== undefined) { sets.push('finished_at = ?'); args.push(patch.finishedAt); }
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

const JOB_SELECT = `
  SELECT j.*, u.username, la.name AS leo_name
    FROM jobs j
    LEFT JOIN users u ON u.id = j.user_id
    LEFT JOIN leo_accounts la ON la.id = j.leo_account_id`;

function listJobs(userId, limit = 50) {
  return get()
    .prepare(JOB_SELECT + ' WHERE j.user_id = ? ORDER BY j.id DESC LIMIT ?')
    .all(Number(userId), Number(limit));
}

function listAllJobs(limit = 100) {
  return get()
    .prepare(JOB_SELECT + ' ORDER BY j.id DESC LIMIT ?')
    .all(Number(limit));
}

/**
 * 某用户「还没跑完」的任务（running / queued / paused）。
 *
 * 用途：管理员禁用 / 删除用户时，要把这些任务一并停下来 —— 否则用户界面上
 * 显示「已禁用」，后台却还在替他刷局。
 */
function listActiveJobsByUser(userId) {
  return get()
    .prepare(
      `SELECT * FROM jobs WHERE user_id = ? AND status IN ('running','queued','paused')
       ORDER BY id DESC`,
    )
    .all(Number(userId));
}

function listJobRounds(jobId, limit = 200) {
  return get()
    .prepare('SELECT * FROM job_rounds WHERE job_id = ? ORDER BY round_no LIMIT ?')
    .all(Number(jobId), Number(limit));
}

/**
 * 把进程被杀时残留的 running/queued 任务标成 failed（语义：服务重启 = 任务中断）。
 * 现在刷练习也是后台任务，重启后会留下僵尸 running 任务，启动时清理一次。
 * @returns {number} 被标记的任务数
 */
function markInterruptedJobs() {
  const now = Date.now();
  const info = get()
    .prepare(
      `UPDATE jobs SET status = 'failed', finished_at = ?, error = ?
        WHERE status IN ('running','queued')`,
    )
    .run(now, '服务重启，任务已中断');
  return Number(info.changes) || 0;
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
  countAdmins,
  countLeoAccountsOfUser,
  deleteUser,
  touchLogin,
  createSession,
  getUserBySession,
  deleteSession,
  deleteSessionsByUser,
  purgeExpiredSessions,
  migrateCookieEncryption,
  addDeviceChain,
  listDeviceChains,
  getDeviceChain,
  deleteDeviceChain,
  upsertDeviceChain,
  setLeoAccountChain,
  getLeoAccountChainId,
  chainUsageMap,
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
  listActiveJobsByUser,
  listJobRounds,
  markInterruptedJobs,
  kvGet,
  kvSet,
  audit,
  listAudit,
};