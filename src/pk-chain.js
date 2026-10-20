'use strict';
// 设备链（`ks_*`）轮换 —— 绕开「出题冷却」的正确方式。
//
// ## 为什么需要它（★ 2026-10-20 实测，这是本轮最关键的一条）
//
// 出题 `400 {"message":"请求过于频繁"}` 的限流**不是按账号算的，是按设备链算的**。
// 对照实验（同一账号，间隔 3 秒）：
//
// | 动作 | 结果 |
// |---|---|
// | 用链 A 出题 | 200 |
// | 立刻再用链 A | **400 请求过于频繁** |
// | 立刻换链 B（同账号、同 cookie jar，只换 `ks_*`） | **200** |
//
// 也就是说：**一条链 60 秒内只能出一次题，换链立刻就能出**。
// 这解释了两件长期困惑的事：
//
//   · App「看起来没有 60 秒限制」—— 它用的是自己那一条真实设备链，一局 30 题
//     本来就要打一分多钟，永远不会在同一秒内二次出题；
//   · 我们每个账号只绑一条池里的链 → 每轮必然撞冷却，怎么改参数都没用。
//
// ## 因此策略是「每轮换一条空闲链」
//
// - 全局记「每条链上次出题时刻」，`CHAIN_COOLDOWN_MS`（默认 65s）内不再选它；
// - 选**最久没用过**的那条（LRU），避免两条链被两个账号同时踩；
// - 出题成功后打时间戳；整轮（出题 → 提交）**必须用同一条链**，
//   所以只在出题前换，提交期间不再动 jar；
// - 池里一条空闲链都没有时返回 null（调用方回落「等一会儿再试」）。
//
// 关闭：`PK_ROTATE_CHAIN=0`（退回「一个账号一条链 + 撞了再等」的老行为）。

const db = require('./db');

/** 一条链两次出题之间的最小间隔（实测服务端 ≈60s，留 5s 余量）。 */
const CHAIN_COOLDOWN_MS = Number(process.env.PK_CHAIN_COOLDOWN_MS || 65_000);

/** 链 id → 上次用于**出题成功**的时刻（模块级，跨轮/跨任务/跨账号共享）。 */
const lastUsedAt = new Map();

/** 记一条链刚被用过。 */
function markUsed(chainId, at) {
  if (chainId == null) return;
  lastUsedAt.set(Number(chainId), at == null ? Date.now() : Number(at));
}

/** 清空（自检/测试用）。 */
function reset() {
  lastUsedAt.clear();
}

/**
 * 取当前 jar 里挂着的设备链 id（没有则 null）。
 *
 * 用于「出题成功后把这条链标记为已用」——调用方只拿到 jar，不关心链。
 */
function chainIdOfJar(jar, pool) {
  const items = (jar && jar.items) || [];
  const dev = items.find((c) => c.name === 'ks_deviceid');
  if (!dev) return null;
  const v = String(dev.value || '');
  for (const c of pool || []) {
    const cs = c.cookies || [];
    const d = cs.find((x) => x.name === 'ks_deviceid');
    if (d && String(d.value || '') === v) return Number(c.id);
  }
  return null;
}

/**
 * 从池里挑一条**最久没用过、且已过冷却**的链。
 *
 * @param {object} [opts]
 * @param {Set<number>} [opts.exclude] 排除的链 id（比如当前这条已经撞了 400）
 * @param {number} [opts.cooldownMs]    覆盖默认冷却
 * @returns {{id:number, deviceId:string, cookies:Array}|null} 没有可用链时 null
 */
function pickFresh(opts = {}) {
  const cooldown = opts.cooldownMs == null ? CHAIN_COOLDOWN_MS : Number(opts.cooldownMs);
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set();
  const now = Date.now();

  let pool = [];
  try {
    pool = db.listDeviceChains(true) || [];
  } catch (e) {
    return null;
  }

  let best = null;
  let bestAt = Infinity;
  for (const c of pool) {
    const id = Number(c.id);
    if (exclude.has(id)) continue;
    const cs = c.cookies || [];
    if (!cs.length) continue;
    if (!cs.some((x) => String(x.name || '').indexOf('ks_') === 0)) continue;
    const last = lastUsedAt.get(id) || 0;
    if (now - last < cooldown) continue;      // 还在冷却里
    if (last < bestAt) { bestAt = last; best = c; }
  }
  if (!best) return null;
  return { id: Number(best.id), deviceId: best.device_id || '', cookies: best.cookies || [] };
}

/**
 * 给 jar 换一条空闲链。
 *
 * @param {object} jar   [leo.CookieJar]（会被就地修改：`ks_*` 整体替换）
 * @param {object} [opts] 透传给 [pickFresh]，另支持 `excludeIds: number[]`
 * @returns {{id:number, deviceId:string}|null} 换成功返回链信息；没链可换返回 null
 */
function rotate(jar, opts = {}) {
  const exclude = opts.exclude instanceof Set
    ? opts.exclude
    : new Set(Array.isArray(opts.excludeIds) ? opts.excludeIds : []);
  const pick = pickFresh(Object.assign({}, opts, { exclude }));
  if (!pick) return null;
  // 延迟 require：避免与 leo-accounts ↔ pk-chain 形成循环依赖
  const { applyDeviceChain } = require('./services/leo-accounts');
  applyDeviceChain(jar, { pasteChain: pick.cookies });
  return { id: pick.id, deviceId: pick.deviceId };
}

/** 池里还有多少条「现在就能用」的链。 */
function availableCount(opts = {}) {
  const cooldown = opts.cooldownMs == null ? CHAIN_COOLDOWN_MS : Number(opts.cooldownMs);
  const now = Date.now();
  let pool = [];
  try { pool = db.listDeviceChains(true) || []; } catch (e) { return 0; }
  return pool.filter((c) => {
    const cs = c.cookies || [];
    if (!cs.length || !cs.some((x) => String(x.name || '').indexOf('ks_') === 0)) return false;
    return now - (lastUsedAt.get(Number(c.id)) || 0) >= cooldown;
  }).length;
}

module.exports = {
  CHAIN_COOLDOWN_MS,
  rotate,
  pickFresh,
  markUsed,
  chainIdOfJar,
  availableCount,
  reset,
};
