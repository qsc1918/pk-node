'use strict';
// pk-node 入口：HTTP 服务 + 路由 + 启动自检。
//
// 零外部依赖：只用 node:http / node:sqlite / node:crypto 等内置模块。
// 静态页面在 public/ 下，是纯原生 HTML+JS（无构建步骤）。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { config, PK } = require('./src/config');
const db = require('./src/db');
const auth = require('./src/services/auth');
const leoAccounts = require('./src/services/leo-accounts');
const loginSvc = require('./src/services/login');
const jobs = require('./src/jobs');
const tunnel = require('./src/tunnel');
const nativeLib = require('./src/native');
const signLib = require('./src/sign');
const strokes = require('./src/strokes');

const PUBLIC_DIR = path.join(config.root, 'public');

/* ---------------------------- 通用工具 ---------------------------- */

/** 读 JSON body（限制大小，避免被塞爆内存）。 */
function readJson(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  }, extraHeaders || {}));
  res.end(body);
}

function sendText(res, status, text, contentType, extraHeaders) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': (contentType || 'text/plain') + '; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  }, extraHeaders || {}));
  res.end(body);
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

/* ---------------------------- 静态文件 ---------------------------- */

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(res, urlPath) {
  // 只允许 public 下的文件；用 resolve + 前缀校验挡目录穿越（../）
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!full.startsWith(PUBLIC_DIR)) return sendText(res, 403, '禁止访问');
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return sendText(res, 404, '未找到');
  const ext = path.extname(full).toLowerCase();
  const body = fs.readFileSync(full);
  res.writeHead(200, {
    'Content-Type': (MIME[ext] || 'application/octet-stream') + '; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ------------------------------ 路由 ------------------------------ */

/** 需要登录的路径前缀。 */
function needAuth(pathname) {
  if (pathname === '/api/auth/login' || pathname === '/api/auth/register' || pathname === '/api/auth/me') return false;
  if (pathname.startsWith('/api/')) return true;
  return false;
}

/** 需要管理员的路径。 */
function needAdmin(pathname) {
  return pathname.startsWith('/api/admin/');
}

async function handleApi(req, res, u, user) {
  const p = u.pathname;
  const method = req.method.toUpperCase();

  /* ------------------------- 认证 ------------------------- */

  if (p === '/api/auth/me' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      user: user ? { id: user.id, username: user.username, role: user.role } : null,
      service: { port: config.port, host: config.host },
    });
  }

  if (p === '/api/auth/register' && method === 'POST') {
    const b = await readJson(req);
    const r = auth.register(b.username, b.password);
    db.audit(null, 'register', String(b.username || ''), clientIp(req));
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/auth/login' && method === 'POST') {
    const b = await readJson(req);
    const r = auth.login(b.username, b.password);
    db.audit(r.user ? r.user.id : null, 'login', r.ok ? '成功' : '失败:' + b.username, clientIp(req));
    if (!r.ok) return sendJson(res, 401, r);
    return sendJson(res, 200, { ok: true, user: r.user }, { 'Set-Cookie': auth.sessionSetCookie(r.token) });
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    auth.logout(auth.readSessionCookie(req.headers.cookie));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearSetCookie() });
  }

  if (p === '/api/auth/password' && method === 'POST') {
    const b = await readJson(req);
    const r = auth.changePassword(user.id, b.oldPassword, b.newPassword);
    db.audit(user.id, 'change_password', r.ok ? '成功' : r.message, clientIp(req));
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  /* ------------------------ 小猿登录（短信 / 密码） ------------------------ */

  // 这些路由在「小猿账号」页用，属于「往库里加账号」的入口，
  // 与「粘贴 cookie 导入」并列 —— 三条路的落库逻辑完全一致。

  if (p === '/api/leo/login/sms/send' && method === 'POST') {
    const b = await readJson(req);
    const r = await loginSvc.sendSmsCode({
      appUserId: user.id,
      phone: b.phone,
      token: b.token || null,
    });
    db.audit(user.id, 'leo_sms_send', `${b.phone} → ${r.ok ? '已发送' : r.message}`, clientIp(req));
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/leo/login/sms/submit' && method === 'POST') {
    const b = await readJson(req);
    const r = await loginSvc.submitSmsCode({
      appUserId: user.id,
      token: b.token,
      code: b.code,
      name: b.name,
    });
    db.audit(user.id, 'leo_sms_login', r.ok ? `成功 id=${r.accountId}` : `失败 ${r.message}`, clientIp(req));
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/leo/login/password' && method === 'POST') {
    const b = await readJson(req);
    const r = await loginSvc.submitPassword({
      appUserId: user.id,
      phone: b.phone,
      password: b.password,
      name: b.name,
    });
    // 审计里**绝不写密码**，只记手机号与结果
    db.audit(user.id, 'leo_password_login', `${b.phone} → ${r.ok ? '成功 id=' + r.accountId : r.message}`, clientIp(req));
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  /* ------------------------ 小猿账号 ------------------------ */

  if (p === '/api/leo/accounts' && method === 'GET') {
    const list = db.listLeoAccounts(user.id).map(publicLeoAccount);
    return sendJson(res, 200, { ok: true, accounts: list });
  }

  if (p === '/api/leo/accounts' && method === 'POST') {
    const b = await readJson(req);
    const r = await leoAccounts.importAccount({
      appUserId: user.id,
      name: String(b.name || '小猿账号'),
      cookieText: b.cookie,
    });
    db.audit(user.id, 'leo_import', (r.ok ? '成功 id=' + r.id : '失败:' + r.message), clientIp(req));
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  const leoRefresh = /^\/api\/leo\/accounts\/(\d+)\/refresh$/.exec(p);
  if (leoRefresh && method === 'POST') {
    const r = await leoAccounts.refreshSubAccounts(Number(leoRefresh[1]));
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  const leoSubs = /^\/api\/leo\/accounts\/(\d+)\/sub-accounts$/.exec(p);
  if (leoSubs && method === 'GET') {
    const id = Number(leoSubs[1]);
    const acc = db.getLeoAccount(id);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '账号不存在' });
    return sendJson(res, 200, { ok: true, subs: db.listSubAccounts(id).map(publicSubAccount) });
  }

  const leoSwitch = /^\/api\/leo\/accounts\/(\d+)\/switch$/.exec(p);
  if (leoSwitch && method === 'POST') {
    const id = Number(leoSwitch[1]);
    const acc = db.getLeoAccount(id);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '账号不存在' });
    const b = await readJson(req);
    const r = await leoAccounts.switchTo(id, Number(b.userId));
    db.audit(user.id, 'leo_switch', `account=${id} target=${b.userId} ${r.ok ? '成功' : r.message.slice(0, 120)}`, clientIp(req));
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  // 查询「当前生效身份」—— 身份由服务端会话绑定，只能靠回包确认（不能靠改 cookie）
  const leoIdentity = /^\/api\/leo\/accounts\/(\d+)\/identity$/.exec(p);
  if (leoIdentity && method === 'GET') {
    const id = Number(leoIdentity[1]);
    const acc = db.getLeoAccount(id);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '账号不存在' });
    try {
      const jar = jobs.jarOf(acc);
      const cur = await require('./src/services/leo-accounts').currentIdentity(jar);
      return sendJson(res, 200, { ok: true, currentIdentity: cur });
    } catch (e) {
      return sendJson(res, 400, { ok: false, message: e.message });
    }
  }

  const leoDel = /^\/api\/leo\/accounts\/(\d+)$/.exec(p);
  if (leoDel && method === 'DELETE') {
    const id = Number(leoDel[1]);
    const acc = db.getLeoAccount(id);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '账号不存在' });
    db.deleteLeoAccount(id);
    db.audit(user.id, 'leo_delete', 'id=' + id, clientIp(req));
    return sendJson(res, 200, { ok: true });
  }

  /* -------------------------- PK 探测 -------------------------- */

  if (p === '/api/pk/points' && method === 'GET') {
    const leoId = Number(u.searchParams.get('leoAccountId'));
    const grade = Number(u.searchParams.get('grade') || 2);
    const acc = db.getLeoAccount(leoId);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '账号不存在' });
    try {
      const jar = jobs.jarOf(acc);
      const r = await require('./src/leo').pkHome(jar, grade);
      if (r.status !== 200) return sendJson(res, 400, { ok: false, message: 'HTTP ' + r.status, body: r.text.slice(0, 500) });
      return sendJson(res, 200, { ok: true, home: r.json });
    } catch (e) {
      return sendJson(res, 400, { ok: false, message: e.message });
    }
  }

  /* --------------------------- 任务 --------------------------- */

  if (p === '/api/jobs' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      jobs: db.listJobs(user.id, 50).map(publicJob),
      busy: jobs.isBusy(),
      concurrency: jobs.runningCount(),
    });
  }

  if (p === '/api/jobs' && method === 'POST') {
    const b = await readJson(req);
    const leoId = Number(b.leoAccountId);
    const acc = db.getLeoAccount(leoId);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '小猿账号不存在' });

    const cfg = {
      pointId: Number(b.pointId || 1951),
      costTimeMs: b.costTimeMs == null || b.costTimeMs === '' ? null : Number(b.costTimeMs),
      // 轮间隔只是「下限」：真正的节奏由出题冷却（≈61.6s/账号，实测）决定，
// 引擎会自动等到「上次成功 + 冷却」再发车，所以这里给小值即可。
      gapMinMs: b.gapMinMs == null ? 4000 : Number(b.gapMinMs),
      gapMaxMs: b.gapMaxMs == null ? 8000 : Number(b.gapMaxMs),
      // 出题成功 → 提交答案 之间的间隔（让节奏更像真人，也错开频控窗口）
      submitDelayMinMs: b.submitDelayMinMs == null ? 0 : Number(b.submitDelayMinMs),
      submitDelayMaxMs: b.submitDelayMaxMs == null ? 0 : Number(b.submitDelayMaxMs),
      rateLimitBaseMs: b.rateLimitBaseMs == null ? PK.rateLimitBaseMs : Number(b.rateLimitBaseMs),
      rateLimitMaxWait: b.rateLimitMaxWait == null ? PK.rateLimitMaxWait : Number(b.rateLimitMaxWait),
      // 出题被频控时的自动重试：间隔 / 总等待上限（见 pk-engine 第 2 步）
      matchRetryIntervalMs: b.matchRetryIntervalMs == null ? 8000 : Number(b.matchRetryIntervalMs),
      matchRetryMaxMs: b.matchRetryMaxMs == null ? 240000 : Number(b.matchRetryMaxMs),
      strokeMode: strokes.normalizeStrokeMode(b.strokeMode),
      subUserId: b.subUserId == null ? null : Number(b.subUserId),
    };
    if (cfg.costTimeMs != null && (!Number.isFinite(cfg.costTimeMs) || cfg.costTimeMs < 0)) {
      return sendJson(res, 400, { ok: false, message: 'costTime 必须是非负数字（留空=自动）' });
    }
    const rounds = Math.max(1, Math.min(999, Number(b.rounds || 10)));
    const jobId = db.createJob(user.id, leoId, cfg.subUserId, cfg, rounds);
    db.audit(user.id, 'job_create', `job=${jobId} rounds=${rounds} pointId=${cfg.pointId}`, clientIp(req));

    const start = jobs.startJob({ jobId: jobId });
    return sendJson(res, start.ok ? 200 : 400, { ok: start.ok, jobId: jobId, message: start.message });
  }

  const jobStop = /^\/api\/jobs\/(\d+)\/stop$/.exec(p);
  if (jobStop && method === 'POST') {
    const b = await readJson(req).catch(() => ({}));
    // immediate 默认 true = 立即结束（中断在途请求与等待）
    const r = jobs.stopJob(Number(jobStop[1]), b.immediate !== false);
    return sendJson(res, 200, r);
  }

  const jobDetail = /^\/api\/jobs\/(\d+)$/.exec(p);
  if (jobDetail && method === 'GET') {
    const id = Number(jobDetail[1]);
    const job = db.getJob(id);
    if (!job || job.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '任务不存在' });
    return sendJson(res, 200, {
      ok: true,
      job: publicJob(job),
      rounds: db.listJobRounds(id, 500),
    });
  }

  const jobStream = /^\/api\/jobs\/(\d+)\/stream$/.exec(p);
  if (jobStream && method === 'GET') {
    const id = Number(jobStream[1]);
    const job = db.getJob(id);
    if (!job || job.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '任务不存在' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // 1) 先发「快照」：当前任务状态 + 已落库的轮次。
    //    没有这一步的话，用户中途刷新页面就只能看到新事件，看不到已经跑完的部分。
    const write = (obj) => {
      try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { /* 已断开 */ }
    };
    write({
      type: 'snapshot',
      at: Date.now(),
      job: publicJob(job),
      rounds: db.listJobRounds(id, 500),
    });

    // 2) 订阅（默认带历史回放），之后才是实时推送
    const unsubscribe = jobs.subscribe(id, write);

    // 心跳，防代理断流
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* 已断开 */ } }, 15000);
    req.on('close', () => { clearInterval(hb); unsubscribe(); });

    // 3) 任务已结束时直接收尾，别让前端一直挂着等
    if (job.status === 'done' || job.status === 'failed' || job.status === 'stopped') {
      write({ type: 'status', message: '任务已结束（' + job.status + '）', finished: true, at: Date.now() });
    }
    return;
  }

  /* -------------------------- 隧道 -------------------------- */

  if (p === '/api/tunnel' && method === 'GET') {
    return sendJson(res, 200, { ok: true, tunnel: tunnel.status() });
  }

  if (p === '/api/tunnel' && method === 'POST') {
    const b = await readJson(req);
    if (b.action === 'stop') return sendJson(res, 200, tunnel.stop());
    const r = await tunnel.start(config.port);
    db.audit(user.id, 'tunnel_start', r.ok ? r.url : r.message, clientIp(req));
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  /* ------------------------- 系统状态 ------------------------- */

  if (p === '/api/system' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      config: {
        host: config.host,
        port: config.port,
        dbFile: config.dbFile,
        sessionTtlMs: config.sessionTtlMs,
      },
      pk: { rateLimitBaseMs: PK.rateLimitBaseMs, rateLimitMaxWait: PK.rateLimitMaxWait },
      native: nativeLib.selfTest(),
      signFixture: signLib.verifyWithFixture(),
      rsa: require('./src/crypto-rsa').selfTest(),
      strokes: strokes.selfTest(),
      strokeModes: Object.keys(strokes.STROKE_MODES).map((k) => ({
        value: k,
        label: strokes.STROKE_MODE_LABELS[k],
      })),
      jobs: { busy: jobs.isBusy(), running: jobs.runningIds() },
    });
  }

  /* ------------------------- 管理后台 ------------------------- */

  if (p === '/api/admin/users' && method === 'GET') {
    if (user.role !== 'admin') return sendJson(res, 403, { ok: false, message: '需要管理员' });
    return sendJson(res, 200, { ok: true, users: db.listUsers() });
  }

  if (p === '/api/admin/users' && method === 'POST') {
    if (user.role !== 'admin') return sendJson(res, 403, { ok: false, message: '需要管理员' });
    const b = await readJson(req);
    const r = auth.register(b.username, b.password);
    if (!r.ok) return sendJson(res, 400, r);
    if (b.role === 'admin') db.get().prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', r.id);
    db.audit(user.id, 'admin_create_user', String(b.username), clientIp(req));
    return sendJson(res, 200, r);
  }

  const adminUserReset = /^\/api\/admin\/users\/(\d+)\/password$/.exec(p);
  if (adminUserReset && method === 'POST') {
    if (user.role !== 'admin') return sendJson(res, 403, { ok: false, message: '需要管理员' });
    const b = await readJson(req);
    const target = db.findUserById(Number(adminUserReset[1]));
    if (!target) return sendJson(res, 404, { ok: false, message: '用户不存在' });
    const np = String(b.password || '');
    if (np.length < auth.MIN_PASSWORD_LEN) return sendJson(res, 400, { ok: false, message: '密码太短' });
    db.setUserPassword(target.id, np);
    db.audit(user.id, 'admin_reset_password', target.username, clientIp(req));
    return sendJson(res, 200, { ok: true });
  }

  const adminUserDisable = /^\/api\/admin\/users\/(\d+)\/disable$/.exec(p);
  if (adminUserDisable && method === 'POST') {
    if (user.role !== 'admin') return sendJson(res, 403, { ok: false, message: '需要管理员' });
    const b = await readJson(req);
    const target = db.findUserById(Number(adminUserDisable[1]));
    if (!target) return sendJson(res, 404, { ok: false, message: '用户不存在' });
    if (target.id === user.id) return sendJson(res, 400, { ok: false, message: '不能禁用自己' });
    db.setUserDisabled(target.id, !!b.disabled);
    db.audit(user.id, 'admin_disable_user', target.username + ' -> ' + (b.disabled ? '禁用' : '启用'), clientIp(req));
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/admin/jobs' && method === 'GET') {
    if (user.role !== 'admin') return sendJson(res, 403, { ok: false, message: '需要管理员' });
    return sendJson(res, 200, { ok: true, jobs: db.listAllJobs(200).map(publicJob) });
  }

  if (p === '/api/admin/audit' && method === 'GET') {
    if (user.role !== 'admin') return sendJson(res, 403, { ok: false, message: '需要管理员' });
    return sendJson(res, 200, { ok: true, audit: db.listAudit(300) });
  }

  return sendJson(res, 404, { ok: false, message: '未知接口：' + p });
}

/* --------------------------- 数据脱敏 --------------------------- */

function publicLeoAccount(a) {
  return {
    id: a.id,
    name: a.name,
    yfdU: a.yfd_u,
    grade: a.grade,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    // cookie 只回数量与名字，不回值（避免页面/日志泄露登录态）
    cookieNames: safeCookieNames(a.cookies_json),
  };
}

function safeCookieNames(json) {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map((c) => c.name) : [];
  } catch (e) {
    return [];
  }
}

function publicSubAccount(s) {
  return {
    id: s.id,
    userId: s.user_id,
    nickname: s.nickname,
    grade: s.grade,
    avatarUrl: s.avatar_url,
    isPrimary: !!s.is_primary,
  };
}

function publicJob(j) {
  return {
    id: j.id,
    userId: j.user_id,
    username: j.username,
    leoAccountId: j.leo_account_id,
    status: j.status,
    config: safeParse(j.config_json),
    roundsTotal: j.rounds_total,
    roundsDone: j.rounds_done,
    roundsFailed: j.rounds_failed,
    createdAt: j.created_at,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
    error: j.error,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

/* ------------------------------ 服务器 ------------------------------ */

const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  } catch (e) {
    return sendText(res, 400, 'URL 非法');
  }

  // 静态资源
  if (!u.pathname.startsWith('/api/')) {
    return serveStatic(res, u.pathname);
  }

  const user = auth.currentUser(req.headers.cookie);
  if (needAuth(u.pathname) && !user) {
    return sendJson(res, 401, { ok: false, message: '未登录' });
  }
  if (needAdmin(u.pathname) && (!user || user.role !== 'admin')) {
    return sendJson(res, 403, { ok: false, message: '需要管理员' });
  }

  try {
    await handleApi(req, res, u, user);
  } catch (e) {
    sendJson(res, 500, { ok: false, message: '服务端错误：' + e.message });
  }
});

/* ------------------------------ 启动 ------------------------------ */

function main() {
  db.init();
  db.purgeExpiredSessions();

  const nt = nativeLib.selfTest();
  const sg = signLib.verifyWithFixture();
  console.log('[pk-node] 启动中…');
  console.log('[pk-node] 编码/sign 自检：' + (nt.ok ? 'OK' : '失败 → ' + nt.detail) +
    (nt.ok && nt.sample ? '（sign 样例 ' + nt.sample + '）' : ''));
  console.log('[pk-node] sign 公式自校验：' + (sg.ok ? 'OK' : '失败（expect ' + sg.expect + ' got ' + sg.got + '）'));
  if (!nt.ok) {
    console.error('[pk-node] ⚠️ 编码链路不可用，PK 提交会失败。请检查 ' + config.nativeDir + ' / bin/keystream.bin');
  }

  server.listen(config.port, config.host, () => {
    console.log('[pk-node] 已监听 http://' + config.host + ':' + config.port);
    console.log('[pk-node] 管理后台默认账号：' + config.defaultAdminUser + ' / ' + config.defaultAdminPass + '（请尽快改密）');
  });

  const shutdown = () => {
    try { tunnel.stop(); } catch (e) { /* 忽略 */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { server, main };