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
 *
 * ## 为什么必须（2026-09-30：「PK 界面一直刷新」的真因）
 *
 * H5 的登录态 isLogin 完全来自桥的 getUserInfo：
 *   index-legacy.CHYoHfC0.js  r("i", ...)：
 *     $t("getUserInfo") → n = r[0] → at("webviewLogin", n)
 *   useHomeModel：isLogin = 上面那个函数的结果
 * 返回空对象时 isLogin=false，pk-legacy 就会：
 *     await dialog({loginTitle:"登录后开始PK"}); window.location.reload();
 *   → 页面无限刷新。
 *
 * 所以每个 H5 页面都要带上该账号的真实 userId/昵称/头像（window.__PK_USER）。
 * 优先用 /math/pk/home 响应里的 baseUserInfoVO（一次调用拿全）；
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
    // ★★ 2026-09-30：兜底 —— 服务端 `baseUserInfoVO` 可能为 null。
    //
    //  实测（账号 7）：POST 请求 `math/pk/home` 返回 200，但 baseUserInfoVO=null
    //  （该账号在 PK 侧没有用户资料，totalWinCount=0 / title=null）。
    //  而 rewriteHtml 只在这个函数返回非空时才注入 window.__PK_USER，
    //  于是 H5 的 getUserInfo 回 `{}` → isLogin=false → 界面显示「未登录」。
    //
    //  兜底：用 cookie 里的 `userid`（真实的 小猿 userId）构造最小可用信息，
    //  保证 isLogin 成立；昵称/头像缺失时由 H5 用占位图，不影响功能。
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

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

/**
 * 轮数解析：**只挡非法值，不再悄悄截断用户填的大数字**。
 *
 * ★ 2026-10-01 用户反馈：「轮数即使填了大于 100 的数，也按 100 来算」。
 * 真因就是这里原来的 `Math.min(99, …)` / `Math.min(999, …)` —— 用户填 500
 * 会被无声改成 99。现在只保留一个足够大的安全上限（防误填天文数字把内存撑爆）。
 */
const MAX_ROUNDS = 100000;
function clampRounds(v, def) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return Math.max(1, Math.floor(Number(def) || 1));
  return Math.min(n, MAX_ROUNDS);
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
  // PK H5 诊断回传：页面本身不需要登录（登录态在 Node 侧注入），
  // 所以这条也免鉴权，否则 hook 的诊断会被 401 挡掉。
  // 同样：H5 hook 的响应解密委托（dataDecrypt 桥），不能要求管理后台会话。
  // ★★ 2026-09-30：PK H5 的出站代理（/api/pk/h5/api）也必须免鉴权！
  //
  //  现象：H5 主页面「登录态没了」、练习/好友PK 进不去、控件变少。
  //  真因：H5 页面发的所有业务请求都经 /api/pk/h5/api 转发，
  //        但 H5 页面**不带管理后台会话 cookie** → 被这里 401
  //        （响应体是 {"ok":false,"message":"未登录"}，不是远端返回的）。
  //        之前测试时我本人浏览器登录着管理后台，所以没暴露。
  //
  //  安全性：代理本身不做鉴权 —— 它用「URL 里 leoAccountId 对应的那个小猿账号」
  //  的 cookie 出站（见 proxyApi），与访问者是不是管理后台用户无关。
  //  这与 /pk-h5/ 页面本身免鉴权的设计一致。
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
    const list = db.listDeviceChains(false).map((x) => ({
      id: x.id,
      label: x.label,
      deviceId: x.device_id,
      enabled: !!x.enabled,
      names: (x.cookies || []).map((c) => c.name),
      bytes: JSON.stringify(x.cookies || []).length,
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
  //
  // H5 页面里注入的 hook 会把「JS 报错 / 未捕获 rejection / 每个被代理请求的结果」
  // 用 sendBeacon 回传到这里，落到服务端日志。这样「点击没反应」这类
  // 纯前端问题也能在无头环境里看到真相，不用开 F12。
  // H5 的响应解密委托端点（2026-09-30）。
  //
  // 为什么需要它：H5 的响应拦截器对 arraybuffer 响应会调桥
  // LeoSecure.dataDecrypt（见 exercise-legacy 的 u/l 函数），而**浏览器里没有
  // keystream**（解密密钥在 Android so 里）。所以桥必须把密文转发到 Node 侧解密：
  //   1) 浏览器 hook：dataDecrypt → fetch 本端点
  //   2) 本端点：keystream XOR + gunzip → 明文 JSON
  //   3) 返回 { result: base64(明文JSON) }，与真机桥协议一致
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
  // ★ 2026-09-30：dataEncrypt 桥的 Node 侧（「局数不增加」的正解）。
  //
  //   H5 提交一局时：明文 JSON --base64--> 桥 dataEncrypt --> 本端点
  //   本端点：明文 --gzip(level6,mtime0)+keystream XOR--> 密文
  //   返回 { result: base64(密文) }，与真机桥协议一致（H5 用 Uint8Array(result) 当 body）。
  //   与真机 libContentEncoder 逐字节一致（复用刷分链路的 native.encodeSubmitBody）。
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
    // ★★ 2026-09-30 修正：**不再要求「小猿账号属于当前管理后台用户」**。
    //
    //  原来的 `acc.user_id !== user.id` 判定导致：
    //    H5 页面（/pk-h5/pk.html）不带管理后台会话 → user=undefined →
    //    所有业务请求被拒（401/404）→ 主页面「登录态没了」、练习/好友PK 进不去。
    //
    //  这里与「/pk-h5/ 页面本身免鉴权」的设计保持一致：页面与出站代理都不需要
    //  管理后台登录；代理只是**用选定小猿账号的 cookie 出站**。
    //  只要该账号在库中存在（用户自己配置的），就允许代理。
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

  if (p === '/api/jobs' && method === 'POST') {
    const b = await readJson(req);
    const leoId = Number(b.leoAccountId);
    const acc = db.getLeoAccount(leoId);
    if (!acc || acc.user_id !== user.id) return sendJson(res, 404, { ok: false, message: '小猿账号不存在' });

    const cfg = {
      pointId: Number(b.pointId || 1951),
      costTimeMs: b.costTimeMs == null || b.costTimeMs === '' ? null : Number(b.costTimeMs),
      // 轮间隔：**唯一的节奏旋钮**。服务端有 ≈60s 的账号级出题冷却（实测仍在），
      // 但引擎按要求**不强制**替你等 —— 你填多少就按多少跑（默认取网页上的推荐值）。
      gapMinMs: b.gapMinMs == null ? 60000 : Number(b.gapMinMs),
      gapMaxMs: b.gapMaxMs == null ? 65000 : Number(b.gapMaxMs),
      // 出题成功 → 提交答案 之间的间隔（让节奏更像真人，也错开频控窗口）
      submitDelayMinMs: b.submitDelayMinMs == null ? 0 : Number(b.submitDelayMinMs),
      submitDelayMaxMs: b.submitDelayMaxMs == null ? 0 : Number(b.submitDelayMaxMs),
      rateLimitBaseMs: b.rateLimitBaseMs == null ? PK.rateLimitBaseMs : Number(b.rateLimitBaseMs),
      rateLimitMaxWait: b.rateLimitMaxWait == null ? PK.rateLimitMaxWait : Number(b.rateLimitMaxWait),
      // 出题被频控时的自动重试：间隔 / 总等待上限（见 pk-engine 第 2 步）
      matchRetryIntervalMs: b.matchRetryIntervalMs == null ? PK.matchRetryIntervalMs : Number(b.matchRetryIntervalMs),
      matchRetryMaxMs: b.matchRetryMaxMs == null ? PK.matchRetryMaxMs : Number(b.matchRetryMaxMs),
      strokeMode: strokes.normalizeStrokeMode(b.strokeMode),
      subUserId: b.subUserId == null ? null : Number(b.subUserId),
    };
    if (cfg.costTimeMs != null && (!Number.isFinite(cfg.costTimeMs) || cfg.costTimeMs < 0)) {
      return sendJson(res, 400, { ok: false, message: 'costTime 必须是非负数字（留空=自动）' });
    }
    // ★ 2026-10-01：不再截断轮数（原来 Math.min(999, …) 会把大数字悄悄改小）。
    //   只挡掉非数字/非正数；上限给一个足够大的安全值防止误填天文数字。
    const rounds = clampRounds(b.rounds, 10);
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
    const rounds = clampRounds(b.rounds, 1);
    const limit = Math.max(1, Math.min(200, Number(b.limit) || 100));
    const keypointId = Number(b.keypointId) || 235001;

    // ★★ 2026-10-01：刷练习改为**正经的后台任务**（跟刷局同一套）。
    //
    //  旧实现是裸的 async IIFE：不落库、不登记 running、不占并行名额，
    //  于是「任务」页看不到它、切 tab 回来日志空白、也没法停止。
    //  现在写一条 jobs 记录（config.kind='exercise'）再交给 jobs.startExerciseJob，
    //  于是：任务页可见 / 逐轮明细落库 / 可停止 / 与刷局共用 SSE。
    const cfg = {
      kind: 'exercise',
      keypointId: keypointId,
      limit: limit,
      gapMinMs: Math.max(0, Number(b.gapMinMs) || 0),
      gapMaxMs: Math.max(0, Number(b.gapMaxMs) || 0),
      costTimePerQuestionMs: b.costTimePerQuestionMs == null ? undefined : Number(b.costTimePerQuestionMs),
      rounds: rounds,
    };
    const jobId = db.createJob(user.id, acc.id, null, cfg, rounds);
    const start = jobs.startExerciseJob({ jobId: jobId });
    db.audit(user.id, 'exercise_run', `job=${jobId} leo=${acc.id} rounds=${rounds} limit=${limit} kp=${keypointId}`, clientIp(req));
    if (!start.ok) {
      db.setJobStatus(jobId, 'failed', { finishedAt: Date.now(), error: start.message });
      return sendJson(res, 400, { ok: false, jobId: jobId, message: start.message });
    }
    return sendJson(res, 200, {
      ok: true,
      jobId: jobId,
      rounds: rounds,
      limit: limit,
      message: `已开始：${rounds} 轮 × ${limit} 题（任务 #${jobId}，可在「任务」页查看进度）`,
    });
  }

  if (p === '/api/exercise/stream' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');
    // 只放行**当前用户**的练习事件（任务属于谁由 job.user_id 决定），
    // 避免多用户环境下互相看到对方的日志。
    const unsub = jobs.subscribe(0, (ev) => {
      if (!ev || !ev.exercise) return;
      if (ev.userId != null && Number(ev.userId) !== Number(user.id)) return;
      try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch (e) { /* 客户端已断 */ }
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
  const cfg = safeParse(j.config_json);
  return {
    id: j.id,
    userId: j.user_id,
    username: j.username,
    leoAccountId: j.leo_account_id,
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
  // ★ 全量访问日志（2026-09-30）：定位「浏览器没到服务端」类问题。
  // 只打印非静态资源的关键路径，避免刷屏。
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
        // ★ 2026-09-30：H5 有入口直接拼 `${location.origin}/bh5/...`
        //   （如「好友挑战」→ /bh5/leo-web-oral-pk/invite-friend.html），
        //   这里一并交给 PK H5 代理处理，否则 404「未提供」。
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
  // 「服务重启 = 任务中断」：清掉上次残留的 running/queued 僵尸任务，
  // 否则「任务」页会永远显示「运行中」且停不掉。
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