'use strict';
// 小猿账号服务：导入登录态 → 探活 → 拉子账号 → 切号。
//
// 默认方案 A（导入登录态 cookie）：真机导出的 cookie 一次性导入后长期复用，
// 比短信验证码（方案 B）链路更简单；方案 B 收尾也仍需 cookie。
// 方案 B 接口预留于文件末尾 TODO(方案B)。

const db = require('../db');
const leo = require('../leo');

/** 需要的关键 cookie（缺失则明显是没登录或导入了错的域）。 */
const REQUIRED_COOKIES = ['sess'];
const HELPFUL_COOKIES = ['userid', 'g_sess', 'persistent', 'sid', 'ks_sess', 'ks_deviceid', 'ks_persistent'];

/**
 * 解析用户粘贴的 cookie 文本，返回 leo.CookieJar。
 * 支持三种输入：完整 `Cookie:` 头 / 每行 `name=value` / JSON 数组。
 *
 * @param {string} text
 * @returns {{ok:boolean, jar?:leo.CookieJar, message?:string, missing?:string[]}}
 */
function parseCookieInput(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, message: 'cookie 内容为空' };

  // 形式 3：JSON 数组
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return { ok: false, message: 'JSON 不是数组' };
      const jar = new leo.CookieJar(arr);
      return finishJar(jar);
    } catch (e) {
      return { ok: false, message: 'JSON 解析失败：' + e.message };
    }
  }

  // 形式 1/2：统一成「分号分隔」
  const normalized = raw.replace(/\r?\n/g, '; ');
  const jar = leo.CookieJar.fromHeader(normalized, 'yuanfudao.com');
  // fromHeader 会把 domain 写成 `.yuanfudao.com`（覆盖所有子域），符合真机 cookie 的域
  return finishJar(jar);
}

function finishJar(jar) {
  const missing = REQUIRED_COOKIES.filter((n) => !jar.get(n));
  if (missing.length > 0) {
    return { ok: false, message: `缺少必需 cookie：${missing.join(', ')}`, missing: missing };
  }
  const absent = HELPFUL_COOKIES.filter((n) => !jar.get(n));
  return { ok: true, jar: jar, missing: absent };
}

/**
 * 克隆一个 cookie jar。
 * 探活/读资料接口会下发 Set-Cookie 改写服务端会话身份，因此「只想取数据、
 * 不改登录态」的调用都跑在克隆 jar 上，副作用随克隆丢弃。
 */
function cloneJar(jar) {
  return new leo.CookieJar(jar.toJSON());
}

/**
 * 探活：调「不需设备链」的上下文接口，确认 cookie 有效并拿到子账号 ID 列表。
 *
 * ⚠️ 跑在**克隆 jar** 上 —— 见 [cloneJar]（该接口会改写服务端身份）。
 *
 * @param {leo.CookieJar} jar
 * @returns {Promise<{ok:boolean, status:number, allSubUserIds?:number[], primarySubUserId?:number, message?:string}>}
 */
async function probe(jar, opts) {
  // capture=true 时在**真实 jar** 上跑：context 的 Set-Cookie 会下发 sid，
  //   而默认 cloneJar 会把这份副作用丢掉，导致落库只有基础 cookie。
  const capture = !!(opts && opts.capture);
  const target = capture ? jar : cloneJar(jar);
  const r = await leo.userInfosContext(target);
  if (r.status !== 200 || !r.json) {
    return { ok: false, status: r.status, message: `上下文接口 HTTP ${r.status}` };
  }
  const ids = Array.isArray(r.json.allSubUserIds) ? r.json.allSubUserIds : [];
  return {
    ok: true,
    status: r.status,
    allSubUserIds: ids,
    primarySubUserId: r.json.primarySubUserId,
    currentUserId: r.json.ytkUserId != null ? Number(r.json.ytkUserId) : null,
  };
}

/**
 * 拉子账号明细：context（稳 200）→ batchGet（可能 401/417，失败不致命）。
 *
 * @returns {Promise<{items:Array, note:string}>}
 */
async function fetchSubAccounts(jar) {
  const ctx = await probe(jar);                 // probe 内部已用克隆 jar
  if (!ctx.ok) return { items: [], note: ctx.message || '拉取失败' };

  const ids = ctx.allSubUserIds || [];
  const current = ctx.currentUserId;
  const primary = ctx.primarySubUserId;

  // 明细（名字/头像/年级）：batchGet 走 MAIN_COMMON_QUERY（android37/3.140.1 + sign）→ 200，
  // 仍跑在克隆 jar 上：batchGet 也会 Set-Cookie，别污染待落库的登录态。
  let detailMap = new Map();
  let note = '';
  const bg = await leo.subAccountsBatchGet(cloneJar(jar));
  if (bg.status === 200 && Array.isArray(bg.json)) {
    for (const vo of bg.json) {
      if (vo && vo.userId != null) detailMap.set(Number(vo.userId), vo);
    }
  } else if (bg.status === 200 && bg.json && Array.isArray(bg.json.data)) {
    for (const vo of bg.json.data) {
      if (vo && vo.userId != null) detailMap.set(Number(vo.userId), vo);
    }
  } else {
    note = `明细接口 HTTP ${bg.status}（需设备链，不影响刷局）`;
  }

  const items = ids.map((idRaw) => {
    const userId = Number(idRaw);
    const vo = detailMap.get(userId);
    return {
      userId: userId,
      nickname: vo ? (vo.nickname || vo.defaultNickname || null) : null,
      avatarUrl: vo ? (vo.avatarUrl || null) : null,
      grade: vo && vo.grade != null ? Number(vo.grade) : null,
      primaryUserId: vo && vo.primaryUserId != null ? Number(vo.primaryUserId) : (primary || null),
      isPrimary: primary != null ? userId === Number(primary) : false,
      isCurrent: current != null ? userId === current : false,
      raw: vo || null,
    };
  });

  return { items: items, note: note };
}

/**
 * 导入（或更新）一个小猿账号：探活 → 拉子账号 → 落库。
 *
 * @param {object} o
 * @param {number} o.appUserId   本服务用户 id
 * @param {string} o.name        显示名
 * @param {string} o.cookieText  粘贴的 cookie
 * @param {number} [o.existingId] 传入则是更新（重新导入）而非新建
 * @returns {Promise<{ok:boolean, id?:number, message?:string, subs?:number, subList?:Array}>}
 */
async function importAccount(o) {
  const parsed = parseCookieInput(o.cookieText);
  if (!parsed.ok) return { ok: false, message: parsed.message };

  const jar = parsed.jar;
  // capture=true：把 context 下发的 sid 收进 jar（否则落库只有 6 条基础 cookie）
  const p = await probe(jar, { capture: true });
  if (!p.ok) {
    return { ok: false, message: 'cookie 无效或已过期：' + (p.message || '') };
  }

  const yfdU = jar.get('userid') || (p.currentUserId != null ? String(p.currentUserId) : null);
  let grade = null;

  // 账号域资料（不需设备链）——拿昵称/头像/年级。
  // 也用克隆 jar：profile 接口同样下发 Set-Cookie，会改写会话绑定的子账号。
  const prof = await leo.ytkUserProfile(cloneJar(jar));
  if (prof.status === 200 && prof.json) {
    const vo = prof.json.data || prof.json;
    if (vo && vo.grade != null) grade = Number(vo.grade);
  }

  // 登录的账号若没有设备链，自动从「设备链池」补一份（多份轮换）。
  const chainInfo = applyDeviceChain(jar);
  if (chainInfo.applied) console.log('[leo] 已自动补齐设备链:', chainInfo.from, chainInfo.deviceId || '');

  // 只落「有值」的 cookie：服务端曾用 Set-Cookie 发 ks_deviceid=空 表示设备链无效，
  // 存空值反而会覆盖已有的好值。
  const cookies = jar.toJSON().filter((c) => String(c.value == null ? '' : c.value).length > 0);
  const existingId = o.existingId == null ? null : Number(o.existingId);
  let id;
  if (existingId) {
    db.updateLeoAccount(existingId, o.name, cookies, { yfdU: yfdU, grade: grade });
    id = existingId;
  } else {
    id = db.addLeoAccount(o.appUserId, o.name, cookies, { yfdU: yfdU, grade: grade });
  }

  const subs = await fetchSubAccounts(jar);
  db.replaceSubAccounts(id, subs.items);

  return {
    ok: true,
    id: id,
    subs: subs.items.length,
    subList: subs.items,
    yfdU: yfdU,
    grade: grade,
    message: subs.note || ('导入成功，发现 ' + subs.items.length + ' 个子账号'),
  };
}

/**
 * 刷新某账号的子账号列表。
 *
 * @returns {Promise<{ok:boolean, subs?:number, message?:string}>}
 */
async function refreshSubAccounts(leoAccountId) {
  const acc = db.getLeoAccount(leoAccountId);
  if (!acc) return { ok: false, message: '账号不存在' };
  const jar = new leo.CookieJar(JSON.parse(acc.cookies_json));
  const subs = await fetchSubAccounts(jar);
  db.replaceSubAccounts(acc.id, subs.items);
  return { ok: true, subs: subs.items.length, message: subs.note || ('已刷新 ' + subs.items.length + ' 个子账号') };
}

/**
 * 查询「当前生效身份」——以服务端回包为准。
 * 用 `GET /leo-game-pk/android/math/pk/home` 的 `baseUserInfoVO.userId`（实测稳定 200，
 * 回包里的 userId 就是服务端认定的当前身份）。
 *
 * ⚠️ 不能靠改 `userid` cookie 切号：服务端完全忽略它，且回包会把它改回去，
 * 身份由服务端会话决定。
 *
 * @returns {Promise<number|null>} 当前 userId；取不到返回 null
 */
async function currentIdentity(jar) {
  try {
    // 克隆 jar：pk/home 也会下发 Set-Cookie，别让它污染待落库的登录态
    const r = await leo.pkHome(cloneJar(jar), 2);
    if (r.status !== 200 || !r.json) return null;
    const vo = r.json.baseUserInfoVO;
    if (!vo || vo.userId == null) return null;
    return Number(vo.userId);
  } catch (e) {
    return null;
  }
}

/**
 * 切换到子账号。
 *
 * 现状：服务端 `POST .../accounts/switch` 对非 App 客户端一律 417
 * （`x-block-by: solar-encoder`，卡传输/编码层，至今未闭环）；
 * 本地改 `userid` cookie 也无效（服务端忽略并改回）。
 *
 * 因此本函数不假装成功：
 *  - 若服务端切号 200 → 正常落库；
 *  - 若失败 → 返回 ok:false 并带上当前生效身份，让用户知道实际会用哪个账号。
 *
 * @returns {Promise<{ok:boolean, message:string, userId?:number, currentIdentity?:number|null, blocked?:boolean}>}
 */
async function switchTo(leoAccountId, targetUserId) {
  const acc = db.getLeoAccount(leoAccountId);
  if (!acc) return { ok: false, message: '账号不存在' };

  const target = Number(targetUserId);
  if (!Number.isFinite(target) || target <= 0) return { ok: false, message: '子账号 ID 非法' };

  const jar = new leo.CookieJar(JSON.parse(acc.cookies_json));

  // 0) 先看当前生效身份 —— 若已是目标，直接如实告知，不必调用被拦的接口
  const cur = await currentIdentity(jar);
  if (cur != null && cur === target) {
    db.updateLeoAccount(acc.id, acc.name, jar.toJSON(), { yfdU: String(target) });
    return {
      ok: true,
      userId: target,
      currentIdentity: cur,
      alreadyActive: true,
      message: `当前生效身份已经是 ${target}，无需切换`,
    };
  }

  // 1) 尝试服务端切号
  let status = 0;
  let body = '';
  try {
    const r = await leo.switchSubAccount(jar, target);
    status = r.status;
    body = String(r.text || '').slice(0, 200);
  } catch (e) {
    return {
      ok: false,
      blocked: false,
      currentIdentity: cur,
      message: `切号请求失败：${e.message}（当前生效身份 ${cur == null ? '未知' : cur}）`,
    };
  }

  if (status === 200) {
    db.updateLeoAccount(acc.id, acc.name, jar.toJSON(), { yfdU: String(target) });
    const subs = await fetchSubAccounts(jar);
    db.replaceSubAccounts(acc.id, subs.items);
    return { ok: true, userId: target, currentIdentity: target, message: `已切换到 ${target}` };
  }

  const code = r0Code(body);
  return {
    ok: false,
    blocked: true,
    currentIdentity: cur,
    message:
      `切换未生效：服务端切号接口被拦（HTTP ${status}${code ? ' ' + code : ''}）。` +
      `当前生效身份仍是 ${cur == null ? '未知' : cur}。` +
      `\n说明：身份由服务端会话绑定，改本地 cookie 无效（已实测）；该接口对非 App 客户端一律 417。` +
      `\n若当前身份已是你需要的小号（本机实测为 小号B），可直接刷局。`,
  };
}

/**
 * 设备链 cookie 名（原版由 POST /leo-auth/android/user-devices 下发）。
 */
const DEVICE_CHAIN_COOKIES = ['ks_deviceid', 'ks_r', 'ks_u', 'ks_sess', 'ks_persistent'];

/** 只暴露 cookie 名 + 是否含设备链（不泄露值）。 */
function cookieNamesOf(id) {
  const acc = db.getLeoAccount(Number(id));
  if (!acc) return null;
  let items = [];
  try { items = JSON.parse(acc.cookies_json); } catch (e) { return null; }
  const names = items.map((c) => c.name);
  const ks = names.filter((n) => n.indexOf('ks_') === 0);
  return { id: acc.id, name: acc.name, names: names, ks: ks, hasDeviceChain: ks.length > 0 };
}

/**
 * 切换子账号（需 arm64 native 才能算 sign）。
 *
 * 关键约束：
 *  - 查询串里 `_productId` 必须放最前（放最后 → 400）；
 *  - 必须带 sign（不带或错 sign → 417 solar-encoder）；417 实为 sign 校验失败，非 TLS 指纹；
 *  - sign 需要 arm64 native（`bin/native/lre.so`），x86/Windows 算不出会 417。
 *
 * @param {number} leoAccountId 库里的小猿账号
 * @param {number} targetUserId 目标子账号 userId
 * @returns {Promise<{ok:boolean, status:number, before?:number, after?:number, message:string}>}
 */
async function switchToSubAccount(leoAccountId, targetUserId) {
  const acc = db.getLeoAccount(Number(leoAccountId));
  if (!acc) return { ok: false, status: 0, message: '账号不存在' };
  const jar = new leo.CookieJar(JSON.parse(acc.cookies_json));

  const before = await currentIdentity(jar);
  const r = await leo.switchSubAccount(jar, Number(targetUserId));
  if (r.status !== 200 || !r.json || Number(r.json.code) !== 1) {
    return {
      ok: false, status: r.status, before: before,
      message: '切换失败 HTTP ' + r.status + '：' + rerr(r.text) +
        (r.status === 417 ? '（417 = sign 校验失败：需 arm64 native 才能算 sign）' : ''),
    };
  }
  // 成功：服务端已下发新 sess/userid（CookieJar 自动吸收）→ 写回库
  const after = await currentIdentity(jar);
  db.updateLeoAccount(acc.id, acc.name, jar.toJSON().filter((c) => String(c.value || '').length > 0), {
    yfdU: after != null ? String(after) : null,
  });
  return {
    ok: true, status: r.status, before: before, after: after,
    message: after != null && String(after) === String(targetUserId)
      ? '已切换到 ' + after
      : ('切换接口成功，但生效身份为 ' + after + '（与目标 ' + targetUserId + ' 不一致）'),
  };
}

/** 从错误体里抠 message。 */
function rerr(text) {
  try { const j = JSON.parse(String(text || '')); return j && j.message ? j.message : String(text || '').slice(0, 80); }
  catch (e) { return String(text || '').slice(0, 80); }
}

/**
 * 从任意 cookie 文本里抽出设备链（`ks_*`）。
 * 只要含 `ks_deviceid` 就认为是一份可用设备链。
 */
function extractDeviceChain(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let items = [];
  try {
    if (raw.startsWith('[') || raw.startsWith('{')) {
      const j = JSON.parse(raw);
      items = Array.isArray(j) ? j : (j.items || []);
    } else {
      items = raw.replace(/\r?\n/g, '; ').split(';').map((part) => {
        const seg = part.trim();
        const i = seg.indexOf('=');
        if (i <= 0) return null;
        return { name: seg.slice(0, i).trim(), value: seg.slice(i + 1).trim(), domain: '.yuanfudao.com', path: '/' };
      }).filter(Boolean);
    }
  } catch (e) { return null; }
  const chain = DEVICE_CHAIN_COOKIES
    .map((n) => items.find((c) => c.name === n))
    .filter((c) => c && String(c.value || '').length > 0)
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain || '.yuanfudao.com', path: c.path || '/' }));
  if (!chain.some((c) => c.name === 'ks_deviceid')) return null;
  return chain;
}

/** 自动把含设备链的 cookie 文本收进「设备链池」（按 ks_deviceid 去重）。 */
function autoPoolDeviceChain(cookieText, label) {
  const chain = extractDeviceChain(cookieText);
  if (!chain) return null;
  const deviceId = (chain.find((c) => c.name === 'ks_deviceid') || {}).value;
  try {
    return db.upsertDeviceChain(label || ('设备链 ' + deviceId), chain, deviceId);
  } catch (e) { return null; }
}

/**
 * 给一个 jar 自动补齐设备链。
 * 优先级：jar 已有 ks_deviceid → 设备链池里 enabled 份（按 pick % 池大小轮换）→ 池空则从库里借。
 *
 * @returns {{applied:boolean, from?:string, deviceId?:string}}
 */
function applyDeviceChain(jar, pick) {
  const has = jar.toJSON().some((c) => c.name === 'ks_deviceid' && String(c.value || '').length > 0);
  if (has) return { applied: false, from: 'self' };

  let pool = [];
  try { pool = db.listDeviceChains(true); } catch (e) { pool = []; }

  // 池空则回退：从已有账号借
  let chain = null;
  let from = null;
  if (pool.length > 0) {
    const idx = Number.isFinite(pick) ? (Math.abs(Number(pick)) % pool.length) : Math.floor(Math.random() * pool.length);
    chain = pool[idx].cookies;
    from = 'pool#' + pool[idx].id + (pool[idx].device_id ? '(' + pool[idx].device_id + ')' : '');
  } else {
    let accs = [];
    try { accs = db.listLeoAccounts(0); } catch (e) { accs = []; }
    if (!accs.length) {
      try { accs = db.get().prepare('SELECT * FROM leo_accounts').all(); } catch (e) { accs = []; }
    }
    for (const a of accs) {
      let items = [];
      try { items = JSON.parse(a.cookies_json); } catch (e) { continue; }
      const c = DEVICE_CHAIN_COOKIES.map((n) => items.find((x) => x.name === n)).filter((x) => x && String(x.value || '').length > 0);
      if (c.some((x) => x.name === 'ks_deviceid')) { chain = c; from = 'account#' + a.id; break; }
    }
  }
  if (!chain) return { applied: false, from: 'none' };

  for (const c of chain) {
    jar.set({ name: c.name, value: c.value, domain: c.domain || '.yuanfudao.com', path: c.path || '/' });
  }
  const dev = (chain.find((c) => c.name === 'ks_deviceid') || {}).value;
  return { applied: true, from: from, deviceId: dev };
}

/**
 * 设备链移植：把源账号的 ks_* 复制到目标账号。
 *
 * 为什么需要：没设备链时 PK 出题（pk/match）实测恒定 400「No message available」，
 * 登录进来的账号刷不了 PK。为什么能移植：ks_deviceid 是设备级标识（非账号级），
 * 同设备/同 App 的 ks_* 复制到别的账号服务端照样认。
 * 注意：只对读/出题类有效；switch（切子账号）仍 417。
 *
 * @param {number} targetId 目标账号（补齐设备链）
 * @param {number} sourceId 源账号（提供 ks_*）
 */
function graftDeviceChain(targetId, sourceId) {
  const t = db.getLeoAccount(Number(targetId));
  const s = db.getLeoAccount(Number(sourceId));
  if (!t) return { ok: false, message: '目标账号不存在' };
  if (!s) return { ok: false, message: '源账号不存在' };
  let tItems = [];
  let sItems = [];
  try { tItems = JSON.parse(t.cookies_json); } catch (e) { tItems = []; }
  try { sItems = JSON.parse(s.cookies_json); } catch (e) { sItems = []; }
  const src = sItems.filter((c) => DEVICE_CHAIN_COOKIES.indexOf(c.name) >= 0 && String(c.value || '').length > 0);
  if (src.length === 0) return { ok: false, message: '源账号没有设备链 cookie（ks_*）' };
  const jar = new leo.CookieJar(tItems);
  for (const c of src) {
    jar.set({ name: c.name, value: c.value, domain: c.domain || '.yuanfudao.com', path: c.path || '/' });
  }
  const merged = jar.toJSON().filter((c) => String(c.value == null ? '' : c.value).length > 0);
  db.updateLeoAccount(t.id, t.name, merged, {});
  return {
    ok: true,
    id: t.id,
    copied: src.map((c) => c.name),
    cookies: merged.length,
    message: '已从「' + s.name + '」移植设备链：' + src.map((c) => c.name).join(', '),
  };
}

/** 从错误体里抠出 message，仅用于展示。 */
function r0Code(text) {
  try {
    const j = JSON.parse(text);
    return j && j.message ? j.message : '';
  } catch (e) {
    return '';
  }
}

module.exports = {
  DEVICE_CHAIN_COOKIES,
  switchToSubAccount,
  extractDeviceChain,
  autoPoolDeviceChain,
  applyDeviceChain,
  cookieNamesOf,
  graftDeviceChain,
  REQUIRED_COOKIES,
  parseCookieInput,
  probe,
  fetchSubAccounts,
  currentIdentity,
  importAccount,
  refreshSubAccounts,
  switchTo,
};