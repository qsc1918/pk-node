'use strict';
// 小猿账号服务：导入登录态 → 探活 → 拉子账号 → 切号。
//
// ## 登录方式选型（用户待拍板：方案 A 导入 cookie / 方案 B 短信验证码）
//
// 本项目**默认实现方案 A（导入登录态 cookie）**，原因：
//   1. 逆向结论里短信登录链路（RSA 加密手机号 + verifier）虽已跑通，
//      但要额外维护公钥/编码器，且每次登录都触发短信，不适合自动刷局；
//   2. 真机导出的 cookie（`.yuanfudao.com` 域，含 `sess/userid/sid/ks_*`）
//      一次性导入后可长期复用（会话 cookie，服务端有效期内一直可用）；
//   3. 方案 B 仍需 cookie 收尾（登录响应也要落 cookie），A 是其子集。
//
// 方案 B 的接口已预留：见文件末尾 `TODO(方案B)`，需要时按
// `ape-api.yuanfudao.com/accounts/android/safe/login` 补即可。

const db = require('../db');
const leo = require('../leo');

/** 需要的关键 cookie（缺失则明显是没登录或导入了错的域）。 */
const REQUIRED_COOKIES = ['sess'];
const HELPFUL_COOKIES = ['userid', 'g_sess', 'persistent', 'sid', 'ks_sess', 'ks_deviceid', 'ks_persistent'];

/**
 * 解析用户粘贴的 cookie 文本，返回 [leo.CookieJar]。
 *
 * 支持三种输入：
 *   1. 完整 `Cookie:` 头：`sess=xxx; userid=123`
 *   2. 每行 `name=value`（从浏览器 DevTools 复制）
 *   3. JSON 数组：`[{"name":"sess","value":"...","domain":".yuanfudao.com"}]`
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
 *
 * ## 为什么探活必须用克隆（2026-09-27 真机踩坑）
 *
 * `GET /leo-profile/api/user-infos/context` 的 **`Set-Cookie` 会改写会话**：
 * 调过它之后，服务端认定的「当前子账号」会被踢回**主号**（实测 主账号A，
 * 而真实可用的小号是 小号B）。
 *
 * 也就是说：如果直接用待落库的 jar 去探活，**探活本身就把身份改坏了**，
 * 之后刷局会用错账号（表现为「已封禁，暂时无法使用」）。
 *
 * 所以凡是「只想拿数据、不想改变登录态」的调用，都跑在克隆 jar 上，
 * 副作用随克隆丢弃。
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
  // ★ capture=true 时在**真实 jar** 上跑：`context` 的 Set-Cookie 会下发 `sid`，
  //   而默认的 cloneJar 会把这份副作用丢掉（导入瘦身后的真 bug，2026-09-28）。
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

  // 明细（名字/头像/年级）——失败就退化成「账号 {uid}」
  // 同样跑在克隆 jar 上：batchGet 也会 Set-Cookie，别污染待落库的登录态。
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
  // ⚠️ 也用克隆 jar：这条同样是 Set-Cookie 大户，会改写会话绑定的子账号
  //    （实测会让生效身份从 小号B 变成主号 主账号A）。
  const prof = await leo.ytkUserProfile(cloneJar(jar));
  if (prof.status === 200 && prof.json) {
    const vo = prof.json.data || prof.json;
    if (vo && vo.grade != null) grade = Number(vo.grade);
  }

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
 * 查询「当前生效身份」——**以服务端回包为准**。
 *
 * 用 `GET /leo-game-pk/android/math/pk/home` 的 `baseUserInfoVO.userId`：
 * 这条接口实测稳定 200，且回包里的 userId 就是服务端认定的当前身份。
 *
 * ## ⚠️ 为什么不能靠改 `userid` cookie 来切号（2026-09-27 实测反证）
 *
 * 试过把 cookie 里的 `userid` 分别改成 `主账号A` / `小号C` /
 * `小号B` 再打 pk/home，**三次回包都是 `小号B`**，而且响应里的
 * `Set-Cookie` 会把本地值改写回去。
 * 结论：**`userid` cookie 被服务端完全忽略**，身份由服务端会话决定。
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
 * ## 现状（2026-09-27 实测，如实记录）
 *
 * | 手段 | 结果 |
 * |---|---|
 * | 服务端 `POST /leo-gateway/android/accounts/switch` | **一律 417** `No message available`（带不带 sign / YFD_U / 风控头 / HTTP2 都一样） |
 * | 本地改 `userid` cookie | **无效** —— 服务端忽略它，且回包把它改回去 |
 *
 * 417 这条路径在原项目里也是同一个结论（「有 `ks_*` → 417 `x-block-by:
 * solar-encoder`，卡传输/编码层，**至今未闭环**」）。
 *
 * 因此本函数**不假装成功**：
 *  - 若服务端切号 200 → 正常落库；
 *  - 若失败 → 返回 `ok:false` 并**带上当前生效身份**，让用户知道实际会用哪个账号。
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
  REQUIRED_COOKIES,
  parseCookieInput,
  probe,
  fetchSubAccounts,
  currentIdentity,
  importAccount,
  refreshSubAccounts,
  switchTo,
};