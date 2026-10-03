// Cloudflare D1：存运行日志（替代 KV）。
//
// ## 为什么换掉 KV
//
// 实测线上报错：`KV put() limit exceeded for the day.`
//   KV 免费层限额：**每天 1000 次写**、10 万次读。
//   而本应用每次跑一轮要写「日志 + state」多条 → 自动跑几小时就把写入额度用光，
//   之后所有写操作全部 500（连「立即跑一轮」都点不动）。
//
// D1 免费层：**10 万行写入/天**、500 万行读取/天 —— 高两个数量级，且是 SQL，适合日志。
//
// ## 表结构
//
//   logs(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, line TEXT)
//
// 首次使用时自动建表（`CREATE TABLE IF NOT EXISTS`）。

let inited = false;

/** 确保表存在（每 isolate 只跑一次）。 */
export async function ensureSchema(db) {
  if (inited) return;
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, line TEXT NOT NULL)',
  ).run();
  inited = true;
}

/** 追加一条日志。 */
export async function addLog(db, line, at) {
  await ensureSchema(db);
  await db.prepare('INSERT INTO logs (at, line) VALUES (?, ?)')
    .bind(at || new Date().toISOString(), String(line))
    .run();
}

/** 读最近 N 条（新的在前）。 */
export async function recentLogs(db, limit) {
  await ensureSchema(db);
  const r = await db.prepare(
    'SELECT at, line FROM logs ORDER BY id DESC LIMIT ?',
  ).bind(Number(limit) || 50).all();
  return (r && r.results) || [];
}

/** 修剪：只保留最近 N 条，避免无限增长。 */
export async function trimLogs(db, keep) {
  await ensureSchema(db);
  const n = Number(keep) || 500;
  await db.prepare(
    'DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)',
  ).bind(n).run();
}