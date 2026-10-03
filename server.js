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
const exercise = require('./src/exercise');
const pkH5 = require('./src/pk-h5-proxy');

const PUBLIC_DIR = path.join(config.root, 'public');

/* ---------------------------- PK H5 依赖注入 ---------------------------- */

/**
 * 给 PK H5 代理注册「取用户信息」的实现。
 * H5 的 isLogin 完全来自桥的 getUserInfo，返回空对象时 pk-legacy 会弹「登录后开始PK」
 * 并 location.reload() 死循环。优先用 /math/pk/home 的 baseUserInfoVO，
 * 拿不到再退到 ytk 的 /accounts/api/current。
 */
pkH5.setUserInfoProvider(async (leoAccountId) => {
  const acc = db.getLeoAccount(leoAccountId);
  if (!acc) return null;
  try {
    const jar = jobs.jarOf(acc);
    const leo = require('./src/leo');
    const r = await leo.pkHome(jar, 3);
    if (r.status === 200 && r.json && r.json.baseUserInfoVO) {
      const u = r.json.baseUserInfoVO;
      if (u.userId) {
        return {
          userId: u.userId,
          nickName: u.userName || '',
          nickname: u.userName || '',
          avatarUrl: u.avatarUrl || '',
          userPendantUrl: u.userPendantUrl || '',
          // 有些分支会读 userTag / gradeId
          userTag: r.json.userTag,
          gradeId: r.json.gradeId,
        };
      }
    }
    // 兜底：baseUserInfoVO 可能为 null（账号在 PK 侧无资料）→ 不注入则 isLogin=false
    // 显示「未登录」。故用 cookie 里的 userid 构造最小信息，保证 isLogin 成立。
    const uid = Number(readCookieFromAccount(acc, 'userid') || 0);
    if (uid) {
      console.log('[pk-h5] baseUserInfoVO 为空，用 cookie userid 兜底：' + uid);
      return {
        userId: uid,
        nickName: '',
        nickname: '',
        avatarUrl: '',
        userPendantUrl: '',
        userTag: r.json && r.json.userTag,
        gradeId: (r.json && r.json.gradeId) || Number(acc.grade) || 0,
      };
    }
  } catch (e) {
    console.log('[pk-h5] pkHome 取用户信息失败：' + e.message);
  }
  return null;
});

/** 从账号的 cookies_json（数组形式）里读取某个 cookie 的值。 */
function readCookieFromAccount(acc, name) {
  try {
    const arr = JSON.parse(acc.cookies_json || '[]');
    if (!Array.isArray(arr)) return '';
    for (const c of arr) {
      if (!c) continue;
      if ((c.name || c.key) === name) return String(c.value || '');
    }
  } catch (e) { /* ignore */ }
  return '';
}

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

/**
 * 开始一个 SSE（Server-Sent Events）响应，返回 `write(payload)`。
 *
 * ## ★★ 2026-10-02：「隧道地址下看不到日志」的修复
 *
 * 通过 Cloudflare 快速隧道（`*.trycloudflare.com`）访问时，日志区一条都刷不出来。
 * 根因是 SSE 这条**长连接**被中间层破坏，有三处必须一起改：
 *
 *  1. **`Cache-Control: no-store` → `no-cache, no-transform`**
 *     `no-store` 在 Cloudflare 边缘不被认作「禁压缩」标记，Edge 仍可能对
 *     响应做压缩/改写；而 `no-transform` 是明确的「不许动 body」。
 *     同一个文件里另一个 SSE 端点（`/api/exercise/stream`）原本就是对的，
 *     只有任务日志流漏了 —— 这就是「练习日志能看、PK 日志看不到」的原因。
 *  2. **`Content-Encoding: identity`**：显式声明不压缩。Cloudflare 会对
 *     `text/event-stream` 尝试 gzip，缓冲一下再吐 ⇒ 前端 EventSource 等到
 *     连接关闭才拿到内容（表现为「一直空白」）。
 *  3. **`Connection: keep-alive` 用 `setHeader` 显式写**：WriteHead 的
 *     `Connection` 在 HTTP/1.1 下容易被改为 `close`，长连接一断，
 *     EventSource 反复重连、每次只拿到快照，看起来就是「没有实时日志」。
 *
 * 另外统一**首包立即 flush**：`res.flushHeaders()` + 立刻写一条注释行
 * （`: ok`），让 Cloudflare / 浏览器都确定「这是一条已经开始的流」，
 * 不会因为「首字节迟迟不来」而超时重试。
 *
 * @param {import('http').ServerResponse} res
 * @param {{retryMs?: number, headers?: Record<string,string>}} [opts]
 *        `retryMs` 会以 SSE 的 `retry:` **字段**（不是 data）原样发出，
 *        告知浏览器断线后多久重连；`headers` 为额外响应头。
 * @returns {(payload: string) => void} 写一行 SSE 数据（自动补 `data: ` 与空行）
 */
function sseStart(res, opts) {
  const o = opts || {};
  const headers = Object.assign({
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform：明示中间层不许压缩/改写（Cloudflare 认这个）
    'Cache-Control': 'no-cache, no-transform',
    // identity：不压缩。SSE 被 gzip 会整段缓冲，前端要等连接关才看到内容
    'Content-Encoding': 'identity',
    Connection: 'keep-alive',
    // nginx / Cloudflare 的缓冲开关（两家都认这个头）
    'X-Accel-Buffering': 'no',
  }, o.headers || {});

  // ⚠️ 必须**先** setHeader、**后** writeHead：
  //   `res.writeHead()` 一旦调用，头部就已发出，此时再 `setHeader()` 会抛
  //   `ERR_HTTP_HEADERS_SENT` → 整个请求处理中断、连接被掐断
  //   （表现就是「日志区什么都没有」，连快照都收不到）。
  for (const k of Object.keys(headers)) res.setHeader(k, headers[k]);
  res.writeHead(200);

  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  // 首包立即发：让中间层确认「流已开始」，避免首字节超时。
  // ⚠️ `retry:` 是 SSE 的**字段**，必须原样写，不能包进 `data:`。
  try {
    if (o.retryMs) res.write('retry: ' + Number(o.retryMs) + '\n\n');
    res.write(': ok\n\n');
  } catch (e) { /* 已断开 */ }

  return function write(payload) {
    // 允许直接传对象（内部序列化）——任务流就是传对象；也允许传已序列化的字符串。
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    try {
      res.write('data: ' + text + '\n\n');
    } catch (e) {
      /* 客户端已断开：由调用方的 req.on('close') 收尾 */
    }
  };
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

/** 轮数解析：只挡非法值，不截断用户填的大数字（仅保留一个安全上限防内存爆）。 */
const MAX_ROUNDS = 100000;
function clampRounds(v, def) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return Math.max(1, Math.floor(Number(def) || 1));
  return Math.min(n, MAX_ROUNDS);
}

/* ---------------------- 任务参数构造（单个 / 批量共用） ---------------------- */
// 「单开」与「批量」共用同一份解析，避免两边漂移；出错返回 { error } 由调用方定状态码。

/** 刷局（PK）参数。 */
function makePkConfig(b) {
  const cfg = {
    pointId: Number(b.pointId || 1951),
    costTimeMs: b.costTimeMs == null || b.costTimeMs === '' ? null : Number(b.costTimeMs),
    // 轮间隔：默认 0/0，引擎不强制等冷却（见 [PK.matchCooldownMs]）。
    gapMinMs: b.gapMinMs == null ? 0 : Number(b.gapMinMs),
    gapMaxMs: b.gapMaxMs == null ? 0 : Number(b.gapMaxMs),
    // 出题成功 → 提交答案 之间的间隔（让节奏更像真人，也错开频控窗口）
    submitDelayMinMs: b.submitDelayMinMs == null ? 8000 : Number(b.submitDelayMinMs),
    submitDelayMaxMs: b.submitDelayMaxMs == null ? 12000 : Number(b.submitDelayMaxMs),
    rateLimitBaseMs: b.rateLimitBaseMs == null ? PK.rateLimitBaseMs : Number(b.rateLimitBaseMs),
    rateLimitMaxWait: b.rateLimitMaxWait == null ? PK.rateLimitMaxWait : Number(b.rateLimitMaxWait),
    // 出题被频控时的自动重试：间隔 / 总等待上限（见 pk-engine 第 2 步）
    matchRetryIntervalMs: b.matchRetryIntervalMs == null ? PK.matchRetryIntervalMs : Number(b.matchRetryIntervalMs),
    matchRetryMaxMs: b.matchRetryMaxMs == null ? PK.matchRetryMaxMs : Number(b.matchRetryMaxMs),
    strokeMode: strokes.normalizeStrokeMode(b.strokeMode),
    subUserId: b.subUserId == null ? null : Number(b.subUserId),
  };
  if (cfg.costTimeMs != null && (!Number.isFinite(cfg.costTimeMs) || cfg.costTimeMs < 0)) {
    return { error: 'costTime 必须是非负数字（留空=自动）' };
  }
  // 只挡非法值，上限给足够大的安全值（见 clampRounds）
  cfg.rounds = clampRounds(b.rounds, 10);
  return cfg;
}

/** 刷练习参数。 */
function makeExerciseConfig(b) {
  const cfg = {
    kind: 'exercise',
    keypointId: Number(b.keypointId) || 235001,
    limit: Math.max(1, Math.min(200, Number(b.limit) || 100)),
    gapMinMs: Math.max(0, Number(b.gapMinMs) || 0),
    gapMaxMs: Math.max(0, Number(b.gapMaxMs) || 0),
    costTimePerQuestionMs: b.costTimePerQuestionMs == null ? undefined : Number(b.costTimePerQuestionMs),
  };
  cfg.rounds = clampRounds(b.rounds, 1);
  return cfg;
}

/**
 * 任务归属判定：本人或管理员可操作。
 *
 * ⚠️ 2026-10-01：此前 `/api/jobs/:id/stop` 没做这个校验 —— 任何登录用户
 *    都能停掉别人的任务。所有任务操作接口现在统一走这里。
 */
function jobBelongsTo(job, user) {
  if (!job || !user) return false;
  if (user.role === 'admin') return true;
  return Number(job.user_id) === Number(user.id);
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
  // PK H5 的 diag/decrypt/encrypt 与出站代理 /api/pk/h5/api 一律免鉴权：
  // H5 页面不带管理后台会话 cookie，鉴权会把它自己的业务请求全 401。
  // 代理本身不做鉴权，它用 URL 里 leoAccountId 对应账号的 cookie 出站。
  if (pathname === '/api/pk/h5/api' || pathname.startsWith('/api/pk/h5/api/')) return false;
  if (pathname === '/api/pk/h5/diag' || pathname === '/api/pk/h5/decrypt' || pathname === '/api/pk/h5/encrypt') return false;
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

  // 被禁用的账号一律拦下（纵深防御：防请求抢在会话清理前进来）。
  if (user && user.disabled) {
    return sendJson(res, 403, { ok: false, message: '账号已被管理员禁用' });
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

  /* ---------------- 设备链池（多份 ks_*，登录账号自动挑一份补齐） ---------------- */
  if (p === '/api/device-chains' && method === 'GET') {
    const usage = db.chainUsageMap();
    const list = db.listDeviceChains(false).map((x) => ({
      id: x.id,
      label: x.label,
      deviceId: x.device_id,
      enabled: !!x.enabled,
      names: (x.cookies || []).map((c) => c.name),
      bytes: JSON.stringify(x.cookies || []).length,
      // 被几个账号「指定使用」（不含走自动轮换的）
      useCount: Number(usage[String(x.id)] || 0),
    }));
    return sendJson(res, 200, { ok: true, chains: list });
  }
  if (p === '/api/device-chains' && method === 'POST') {
    const b = await readJson(req);
    const chain = leoAccounts.extractDeviceChain(b.cookie);
    if (!chain) return sendJson(res, 400, { ok: false, message: '这段文本里没有可用设备链（需含 ks_deviceid）' });
    const deviceId = (chain.find((c) => c.name === 'ks_deviceid') || {}).value;
    const r = db.upsertDeviceChain(String(b.label || ('设备链 ' + deviceId)), chain, deviceId);
    db.audit(user.id, 'device_chain_add', `id=${r.id} device=${deviceId} created=${r.created}`, clientIp(req));
    return sendJson(res, 200, { ok: true, id: r.id, created: r.created, deviceId: deviceId, names: chain.map((c) => c.name) });
  }
  const dcItem = /^\/api\/device-chains\/(\d+)$/.exec(p);
  if (dcItem && method === 'DELETE') {
    db.deleteDeviceChain(Number(dcItem[1]));
    db.audit(user.id, 'device_chain_del', 'id=' + dcItem[1], clientIp(req));
    return sendJson(res, 200, { ok: true });
  }

  /* ---------------- 账号 → 设备链（指定这个账号使用池里哪一份） ---------------- */
  const leoChainBind = /^\/api\/leo\/accounts\/(\d+)\/chain$/.exec(p);
  if (leoChainBind && method === 'PUT') {
    const id = Number(leoChainBind[1]);
    const acc = db.getLeoAccount(id);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '账号不存在' });
    const b = await readJson(req);
    let chainId = null;
    try {
      const raw = b.deviceChainId === undefined || b.deviceChainId === null || b.deviceChainId === ''
        || b.deviceChainId === 'auto' || b.deviceChainId === 'null'
        ? null : b.deviceChainId;
      chainId = db.setLeoAccountChain(id, raw);
    } catch (e) {
      return sendJson(res, 400, { ok: false, message: e.message });
    }
    db.audit(user.id, 'leo_bind_chain', `account=${id} chain=${chainId == null ? 'auto' : chainId}`, clientIp(req));
    return sendJson(res, 200, { ok: true, id: id, deviceChainId: chainId });
  }

  /* ---------------- cookie 加密迁移（旧明文 → 加密） ---------------- */
  if (p === '/api/leo/accounts/migrate-crypt' && method === 'POST') {
    const r = db.migrateCookieEncryption();
    db.audit(user.id, 'leo_migrate_crypt', JSON.stringify(r), clientIp(req));
    return sendJson(res, 200, Object.assign({ ok: true }, r));
  }

  // 设备链状态（给 UI：每个账号是否含 ks_*）
  const leoChain = /^\/api\/leo\/accounts\/(\d+)\/device-chain$/.exec(p);
  if (leoChain && method === 'GET') {
    const id = Number(leoChain[1]);
    const acc = db.getLeoAccount(id);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '账号不存在' });
    return sendJson(res, 200, { ok: true, chain: leoAccounts.cookieNamesOf(id) });
  }
  if (leoChain && method === 'POST') {
    const b = await readJson(req);
    const targetId = Number(leoChain[1]);
    const acc = db.getLeoAccount(targetId);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '账号不存在' });
    const src = db.getLeoAccount(Number(b.sourceId));
    if (!src || src.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '源账号不存在' });
    const r = leoAccounts.graftDeviceChain(targetId, Number(b.sourceId));
    db.audit(user.id, 'leo_graft_chain', `target=${targetId} source=${b.sourceId} ok=${r.ok}`, clientIp(req));
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
    const r = await leoAccounts.switchToSubAccount(id, Number(b.userId));
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

  /* -------------------------- PK H5 诊断（浏览器回传） -------------------------- */
  // H5 hook 用 sendBeacon 把 JS 报错 / 请求结果回传到这里（落服务端日志）。
  // 解密委托端点：H5 的 dataDecrypt 桥把密文转发过来（浏览器无 keystream），
  // 本端点 keystream XOR + gunzip → 明文，回 { result: base64(明文JSON) }。
  if (p === '/api/pk/h5/decrypt') {
    const txt = await new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (d) => {
        size += d.length;
        if (size > 4 * 1024 * 1024) { req.destroy(); return; }
        chunks.push(d);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
    let out = { ok: false };
    try {
      const body = JSON.parse(txt || '{}');
      const raw = Buffer.from(String(body.base64 || ''), 'base64');
      const plain = pkH5.decryptBuffer(raw);
      if (!plain) {
        out = { ok: false, message: 'decrypt failed' };
      } else {
        out = { ok: true, result: plain.toString('base64'), size: plain.length };
      }
    } catch (e) {
      out = { ok: false, message: String(e && e.message) };
    }
    const buf = Buffer.from(JSON.stringify(out), 'utf8');
    res.writeHead(out.ok ? 200 : 500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
    return;
  }
  // dataEncrypt 桥的 Node 侧：明文 → gzip + keystream XOR → { result: base64(密文) }，
  // 复用 native.encodeSubmitBody（与真机 libContentEncoder 逐字节一致）。
  if (p === '/api/pk/h5/encrypt') {
    const txt = await new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (d) => {
        size += d.length;
        if (size > 4 * 1024 * 1024) { req.destroy(); return; }
        chunks.push(d);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
    let out = { ok: false };
    try {
      const body = JSON.parse(txt || '{}');
      const plain = Buffer.from(String(body.base64 || ''), 'base64');
      const cipher = nativeLib.encodeSubmitBody(plain);
      out = { ok: true, result: cipher.toString('base64'), size: cipher.length };
    } catch (e) {
      out = { ok: false, message: String(e && e.message) };
    }
    const buf = Buffer.from(JSON.stringify(out), 'utf8');
    res.writeHead(out.ok ? 200 : 500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
    return;
  }
  if (p === '/api/pk/h5/diag') {
    const txt = await new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (d) => {
        size += d.length;
        if (size > 256 * 1024) { req.destroy(); return; }
        chunks.push(d);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
    const leoId = u.searchParams.get('leoAccountId') || '';
    console.log('[pk-h5-diag] leo=' + leoId + ' ' + txt.slice(0, 1500));
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  /* -------------------------- PK H5 页面（真·PK 容器） -------------------------- */
  //
  // 把原版 PK H5（`leo.fbcontent.cn/bh5/leo-web-oral-pk/pk.html`）整套代理到本机：
  // assets 与页面本身走 `/pk-h5/*`（无需登录，见 server 里 serveStatic 之后的
  // 静态分支），H5 发往 xyks/xyst 的 API 请求被注入的 XHR hook 改写到
  // `/api/pk/h5/api` —— 这里就是那个终点，用**该小猿账号**的 jar 补
  // sign/风控头后转发。
  if (p === '/api/pk/h5/api') {
    const leoId = Number(u.searchParams.get('leoAccountId') || 0);
    const acc = db.getLeoAccount(leoId);
    // 不要求「小猿账号属于当前管理后台用户」：H5 页面不带后台会话，否则业务请求全被拒。
    // 代理只用选定小猿账号的 cookie 出站，账号在库中存在即可。
    if (!acc) return sendJson(res, 404, { ok: false, message: '账号不存在' });
    return pkH5.proxyApi(req, res, u, { jar: jobs.jarOf(acc) });
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

  /* ---- 批量开任务：多个小猿账号用同一套配置，各建一条独立 jobs 记录 ---- */
  // 每个账号独立计数/可停，共用同一份参数快照；某个账号失败不影响其它。
  if (p === '/api/jobs/batch' && method === 'POST') {
    const b = await readJson(req);
    const ids = (Array.isArray(b.leoAccountIds) ? b.leoAccountIds : [])
      .map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
    const uniq = Array.from(new Set(ids));
    if (uniq.length === 0) return sendJson(res, 400, { ok: false, message: '请先勾选至少一个小猿账号' });
    if (uniq.length > 100) return sendJson(res, 400, { ok: false, message: '一次最多 100 个账号' });

    const kind = b.kind === 'exercise' ? 'exercise' : 'pk';
    const results = [];
    let okCount = 0;
    for (const leoId of uniq) {
      const acc = db.getLeoAccount(leoId);
      if (!acc || acc.user_id !== user.id) {
        results.push({ leoAccountId: leoId, ok: false, message: '小猿账号不存在' });
        continue;
      }
      let jobId, start;
      if (kind === 'exercise') {
        const cfg = makeExerciseConfig(b);
        if (cfg.error) { results.push({ leoAccountId: leoId, name: acc.name, ok: false, message: cfg.error }); continue; }
        jobId = db.createJob(user.id, leoId, null, cfg, cfg.rounds);
        start = jobs.startExerciseJob({ jobId: jobId });
        if (!start.ok) db.setJobStatus(jobId, 'failed', { finishedAt: Date.now(), error: start.message });
      } else {
        const cfg = makePkConfig(b);
        if (cfg.error) { results.push({ leoAccountId: leoId, name: acc.name, ok: false, message: cfg.error }); continue; }
        jobId = db.createJob(user.id, leoId, cfg.subUserId, cfg, cfg.rounds);
        start = jobs.startJob({ jobId: jobId });
        if (!start.ok) db.setJobStatus(jobId, 'failed', { finishedAt: Date.now(), error: start.message });
      }
      if (start.ok) okCount++;
      results.push({
        leoAccountId: leoId, name: acc.name, ok: !!start.ok, jobId: jobId, message: start.message,
      });
    }
    db.audit(user.id, 'job_batch_create', `kind=${kind} n=${uniq.length} ok=${okCount}`, clientIp(req));
    return sendJson(res, 200, {
      ok: okCount > 0,
      kind: kind,
      started: okCount,
      failed: uniq.length - okCount,
      results: results,
      message: `已启动 ${okCount}/${uniq.length} 个任务` + (okCount < uniq.length ? '（部分失败，见明细）' : ''),
    });
  }

  if (p === '/api/jobs' && method === 'POST') {
    const b = await readJson(req);
    const leoId = Number(b.leoAccountId);
    const acc = db.getLeoAccount(leoId);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '小猿账号不存在' });

    const cfg = makePkConfig(b);
    if (cfg.error) return sendJson(res, 400, { ok: false, message: cfg.error });
    const rounds = cfg.rounds;
    const jobId = db.createJob(user.id, leoId, cfg.subUserId, cfg, rounds);
    db.audit(user.id, 'job_create', `job=${jobId} rounds=${rounds} pointId=${cfg.pointId}`, clientIp(req));

    const start = jobs.startJob({ jobId: jobId });
    return sendJson(res, start.ok ? 200 : 400, { ok: start.ok, jobId: jobId, message: start.message });
  }

  /* ---- 停止 / 暂停 / 继续（普通用户只能动自己的任务） ---- */
  //
  // ⚠️ 2026-10-01 修了个洞：原来的 `/api/jobs/:id/stop` **完全没校验归属**，
  //    任何登录用户都能把别人的任务停掉。这里统一走 `jobBelongsTo` 校验。
  const jobStop = /^\/api\/jobs\/(\d+)\/stop$/.exec(p);
  if (jobStop && method === 'POST') {
    const id = Number(jobStop[1]);
    const job = db.getJob(id);
    if (!job || !jobBelongsTo(job, user)) return sendJson(res, 404, { ok: false, message: '任务不存在' });
    const b = await readJson(req).catch(() => ({}));
    // immediate 默认 true = 立即结束（中断在途请求与等待）
    const r = jobs.stopJob(id, b.immediate !== false, { mode: b.mode === 'pause' ? 'pause' : 'stop' });
    db.audit(user.id, 'job_stop', `job=${id} mode=${(r && r.mode) || 'stop'}`, clientIp(req));
    return sendJson(res, 200, r);
  }

  const jobPause = /^\/api\/jobs\/(\d+)\/pause$/.exec(p);
  if (jobPause && method === 'POST') {
    const id = Number(jobPause[1]);
    const job = db.getJob(id);
    if (!job || !jobBelongsTo(job, user)) return sendJson(res, 404, { ok: false, message: '任务不存在' });
    const r = jobs.stopJob(id, true, { mode: 'pause' });
    db.audit(user.id, 'job_pause', 'job=' + id, clientIp(req));
    return sendJson(res, 200, r);
  }

  const jobResume = /^\/api\/jobs\/(\d+)\/resume$/.exec(p);
  if (jobResume && method === 'POST') {
    const id = Number(jobResume[1]);
    const job = db.getJob(id);
    if (!job || !jobBelongsTo(job, user)) return sendJson(res, 404, { ok: false, message: '任务不存在' });
    const r = jobs.resumeJob(id);
    db.audit(user.id, 'job_resume', 'job=' + id + (r.ok ? ' ok' : ' ' + r.message), clientIp(req));
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  const jobDetail = /^\/api\/jobs\/(\d+)$/.exec(p);
  if (jobDetail && method === 'GET') {
    const id = Number(jobDetail[1]);
    const job = db.getJob(id);
    if (!job || !jobBelongsTo(job, user)) return sendJson(res, 404, { ok: false, message: '任务不存在' });
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
    // 管理员可以旁观任何人的任务日志（管理页「明细」要用）
    if (!job || !jobBelongsTo(job, user)) return sendJson(res, 404, { ok: false, message: '任务不存在' });

    // ★ 统一走 sseStart()：隧道（Cloudflare）下 no-store 会被边缘压缩/缓冲，
    //   导致「一条日志都刷不出来」。详见 sseStart 的注释。
    const write = sseStart(res, { retryMs: 3000 });
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

  /* ------------------------- 练习 / 刷分 ------------------------- */
  if (p === '/api/exercise/overview' && method === 'GET') {
    const leoId = Number(u.searchParams.get('leoAccountId') || 0);
    const acc = db.getLeoAccount(leoId);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '小猿账号不存在' });
    const jar = jobs.jarOf(acc);
    const r = await exercise.overview(jar);
    return sendJson(res, r.ok ? 200 : 502, Object.assign({ limits: exercise.explainLimits() }, r));
  }

  if (p === '/api/exercise/keypoints' && method === 'GET') {
    const leoId = Number(u.searchParams.get('leoAccountId') || 0);
    const acc = db.getLeoAccount(leoId);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '小猿账号不存在' });
    const jar = jobs.jarOf(acc);
    const r = await exercise.keypoints(jar, {
      book: u.searchParams.get('book'), grade: u.searchParams.get('grade'),
      semester: u.searchParams.get('semester'), type: u.searchParams.get('type'),
      count: u.searchParams.get('count'),
    });
    return sendJson(res, r.status === 200 ? 200 : 502, { ok: r.status === 200, status: r.status, data: r.json, text: r.text.slice(0, 1500) });
  }

  if (p === '/api/exercise/exam' && method === 'POST') {
    const b = await readJson(req);
    const acc = db.getLeoAccount(Number(b.leoAccountId));
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '小猿账号不存在' });
    const jar = jobs.jarOf(acc);
    const r = await exercise.getExam(jar, b.keypointId || 235001, b.limit || 10);
    return sendJson(res, r.status === 200 ? 200 : 502, {
      ok: r.status === 200, status: r.status, exam: r.json, text: r.text.slice(0, 1500),
    });
  }

  if (p === '/api/exercise/pump' && method === 'POST') {
    const b = await readJson(req);
    const acc = db.getLeoAccount(Number(b.leoAccountId));
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '小猿账号不存在' });
    const jar = jobs.jarOf(acc);
    const r = await exercise.pumpScore(jar, {
      delta: b.delta, ruleTypes: b.ruleTypes,
      onEvent: (ev) => jobs.publish(0, Object.assign({ exercise: true, at: Date.now() }, ev)),
    });
    db.audit(user.id, 'exercise_pump', `leo=${acc.id} gained=${r.gained} ${r.before}->${r.after}`, clientIp(req));
    return sendJson(res, 200, r);
  }

  /* ---- 完整练习闭环：出题 → 抄答案 → 提交 ---- */
  if (p === '/api/exercise/run' && method === 'POST') {
    const b = await readJson(req);
    const acc = db.getLeoAccount(Number(b.leoAccountId));
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '小猿账号不存在' });

    // 刷练习走正经后台任务：写一条 jobs 记录（kind='exercise'）再交给 startExerciseJob，
    // 于是任务页可见、逐轮落库、可停止、与刷局共用 SSE。
    const cfg = makeExerciseConfig(b);
    const jobId = db.createJob(user.id, acc.id, null, cfg, cfg.rounds);
    const start = jobs.startExerciseJob({ jobId: jobId });
    db.audit(user.id, 'exercise_run', `job=${jobId} leo=${acc.id} rounds=${cfg.rounds} limit=${cfg.limit} kp=${cfg.keypointId}`, clientIp(req));
    if (!start.ok) {
      db.setJobStatus(jobId, 'failed', { finishedAt: Date.now(), error: start.message });
      return sendJson(res, 400, { ok: false, jobId: jobId, message: start.message });
    }
    return sendJson(res, 200, {
      ok: true,
      jobId: jobId,
      rounds: cfg.rounds,
      limit: cfg.limit,
      message: `已开始：${cfg.rounds} 轮 × ${cfg.limit} 题（任务 #${jobId}，可在「任务」页查看进度）`,
    });
  }

  if (p === '/api/exercise/stream' && method === 'GET') {
    // ★ 与任务日志流共用 sseStart()：同样的隧道（Cloudflare）抗性。
    const writeEx = sseStart(res, { retryMs: 3000 });
    // 只放行**当前用户**的练习事件（任务属于谁由 job.user_id 决定），
    // 避免多用户环境下互相看到对方的日志。
    const unsub = jobs.subscribe(0, (ev) => {
      if (!ev || !ev.exercise) return;
      if (ev.userId != null && Number(ev.userId) !== Number(user.id)) return;
      writeEx(JSON.stringify(ev));
    });
    const hb = setInterval(() => { try { res.write(':ping\n\n'); } catch (e) { /* ignore */ } }, 15000);
    req.on('close', () => { clearInterval(hb); unsub(); });
    return;
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
    // 带上账号数与运行中任务数（删除前给管理员看清要删什么）
    const users = db.listUsers().map((u) => Object.assign({}, u, {
      leoAccounts: db.countLeoAccountsOfUser(u.id),
      activeJobs: db.listActiveJobsByUser(u.id).length,
    }));
    return sendJson(res, 200, { ok: true, users: users });
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
    const disable = !!b.disabled;
    db.setUserDisabled(target.id, disable);

    // 禁用 = 暂停他全部任务（mode:'pause' 保留已刷轮数）+ 删掉所有会话（页面立刻 401）。
    // auth.currentUser 对 disabled 返回 null，其它设备的下一个请求也会被挡。
    let paused = 0, kicked = 0;
    if (disable) {
      paused = jobs.stopJobsByUser(target.id, { mode: 'pause' });
      kicked = db.deleteSessionsByUser(target.id);
    }
    db.audit(user.id, 'admin_disable_user',
      target.username + ' -> ' + (disable ? `禁用（暂停 ${paused} 个任务，踢掉 ${kicked} 个会话）` : '启用'),
      clientIp(req));
    return sendJson(res, 200, {
      ok: true, pausedJobs: paused, kickedSessions: kicked,
      message: disable
        ? `已禁用：暂停 ${paused} 个任务，强制退出 ${kicked} 个登录会话`
        : '已启用（被暂停的任务仍保持暂停，用户可自行「继续」）',
    });
  }

  /* ------------------------ 删除账号 ------------------------ */
  // 三条保护：不能删自己、不能删最后一个管理员、删前先停任务清会话。
  // 级联：users 删除后由外键 ON DELETE CASCADE 连带清掉 sessions/leo_accounts/jobs 等。
  const adminUserDelete = /^\/api\/admin\/users\/(\d+)$/.exec(p);
  if (adminUserDelete && method === 'DELETE') {
    if (user.role !== 'admin') return sendJson(res, 403, { ok: false, message: '需要管理员' });
    const id = Number(adminUserDelete[1]);
    if (id === user.id) return sendJson(res, 400, { ok: false, message: '不能删除自己' });
    const target = db.findUserById(id);
    if (!target) return sendJson(res, 404, { ok: false, message: '用户不存在' });
    if (target.role === 'admin' && db.countAdmins() <= 1) {
      return sendJson(res, 400, { ok: false, message: '这是最后一个管理员，不能删除' });
    }
    const leoCount = db.countLeoAccountsOfUser(id);
    // 删除前先停任务：级联只删记录，内存里的循环还在跑。
    const stopped = jobs.stopJobsByUser(id, { mode: 'stop' });
    const kicked = db.deleteSessionsByUser(id);
    db.deleteUser(id);
    db.audit(user.id, 'admin_delete_user',
      `${target.username}（role=${target.role}）· 小猿账号 ${leoCount} 个 · 停任务 ${stopped} · 清会话 ${kicked}`,
      clientIp(req));
    return sendJson(res, 200, {
      ok: true, stoppedJobs: stopped, kickedSessions: kicked, leoAccounts: leoCount,
      message: `已删除 ${target.username}：停止 ${stopped} 个任务，清理 ${leoCount} 个小猿账号`,
    });
  }

  /* ------------------------ 全部任务（管理视角） ------------------------ */

  if (p === '/api/admin/jobs' && method === 'GET') {
    if (user.role !== 'admin') return sendJson(res, 403, { ok: false, message: '需要管理员' });
    return sendJson(res, 200, {
      ok: true,
      jobs: db.listAllJobs(200).map(publicJob),
      running: jobs.runningIds(),        // 内存里真正在跑的（比 status 字段更实时）
    });
  }

  // 管理员看任意任务的明细（逐轮日志）—— 普通接口 /api/jobs/:id 只放行本人
  const adminJobOne = /^\/api\/admin\/jobs\/(\d+)$/.exec(p);
  if (adminJobOne && method === 'GET') {
    if (user.role !== 'admin') return sendJson(res, 403, { ok: false, message: '需要管理员' });
    const id = Number(adminJobOne[1]);
    const job = db.getJob(id);
    if (!job) return sendJson(res, 404, { ok: false, message: '任务不存在' });
    return sendJson(res, 200, {
      ok: true,
      job: publicJob(job),
      rounds: db.listJobRounds(id, 500),
    });
  }

  /**
   * 管理员批量操控任务：stop / pause / resume。
   *
   * 为什么单独一个接口而不是复用 `/api/jobs/:id/*`：
   * 管理页要「勾 6 个任务一起停」，逐个请求 6 次既慢又容易半途失败。
   * 这里一次请求做完，逐条返回成败，前端照实显示。
   */
  if (p === '/api/admin/jobs/action' && method === 'POST') {
    if (user.role !== 'admin') return sendJson(res, 403, { ok: false, message: '需要管理员' });
    const b = await readJson(req);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isFinite(n));
    const action = String(b.action || '');
    if (!ids.length) return sendJson(res, 400, { ok: false, message: '请先选择任务' });
    if (!['stop', 'pause', 'resume'].includes(action)) {
      return sendJson(res, 400, { ok: false, message: '未知操作：' + action });
    }
    const results = [];
    let okCount = 0;
    for (const id of ids) {
      const job = db.getJob(id);
      if (!job) { results.push({ id: id, ok: false, message: '任务不存在' }); continue; }
      let r;
      if (action === 'resume') r = jobs.resumeJob(id);
      else r = jobs.stopJob(id, true, { mode: action === 'pause' ? 'pause' : 'stop' });
      if (r.ok) okCount++;
      results.push({ id: id, ok: !!r.ok, message: r.message });
    }
    db.audit(user.id, 'admin_job_' + action, `ids=${ids.join(',')} ok=${okCount}`, clientIp(req));
    const label = { stop: '停止', pause: '暂停', resume: '继续' }[action];
    return sendJson(res, 200, {
      ok: okCount > 0, action: action, done: okCount, failed: ids.length - okCount, results: results,
      message: `${label} ${okCount}/${ids.length} 个任务`,
    });
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
    // 该账号「指定使用」的设备链 id；null = 不指定（到时才在池里随机挑一份）
    // 只回 id，label 由页面拿 /api/device-chains 自己配对，避免顺带泄露 cookie 值。
    deviceChainId: a.device_chain_id == null ? null : Number(a.device_chain_id),
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
  const cfg = safeParse(j.config_json);
  return {
    id: j.id,
    userId: j.user_id,
    username: j.username || null,
    leoAccountId: j.leo_account_id,
    // 2026-10-01：管理页要显示「谁在用哪个小猿账号在刷」，所以带上账号名
    leoName: j.leo_name || null,
    subUserId: j.sub_user_id == null ? null : j.sub_user_id,
    status: j.status,
    // 'exercise' = 刷练习（2026-10-01 起练习也是正经后台任务）；默认 'pk' = 刷局
    kind: (cfg && cfg.kind) || 'pk',
    config: cfg,
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
  // 关键路径访问日志（定位「浏览器没到服务端」类问题；不打印静态资源，避免刷屏）。
  try {
    const _p = String(req.url || '');
    if (_p.indexOf('/pk-h5') === 0 || _p.indexOf('/pk-h5-cdn') === 0 || _p.indexOf('/api/pk') === 0) {
      console.log('[http] ' + req.method + ' ' + _p.slice(0, 200));
    }
  } catch (e) { /* ignore */ }
  let u;
  try {
    u = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  } catch (e) {
    return sendText(res, 400, 'URL 非法');
  }

  // 静态资源
  if (!u.pathname.startsWith('/api/')) {
    // PK H5 容器（真·PK 页面）：把原版 H5 整套从 CDN 代理到本机同源。
    // 必须在 serveStatic 之前 —— 它不属于 public/ 目录，是 CDN 透传。
    // 无需登录：页面本身不含凭据，登录态由 H5 的 API 请求（走 /api/pk/h5/api）
    // 在 Node 侧注入。
    if (u.pathname === '/pk-h5' || u.pathname.startsWith('/pk-h5/') ||
        u.pathname.startsWith('/pk-h5-cdn/') ||
        // H5 有入口直接拼 `${location.origin}/bh5/...`，一并交给 PK H5 代理，否则 404。
        u.pathname.indexOf('/bh5/') === 0) {
      try {
        const handled = await pkH5.serve(req, res, u);
        if (handled) return;
      } catch (e) {
        return sendText(res, 502, 'PK H5 代理异常：' + e.message);
      }
    }
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
  // 服务重启 = 任务中断：清掉残留的 running/queued 僵尸任务，否则任务页永远显示「运行中」。
  const interrupted = db.markInterruptedJobs();
  if (interrupted > 0) console.log('[pk-node] 已把 ' + interrupted + ' 个中断任务标记为失败（服务重启）');

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