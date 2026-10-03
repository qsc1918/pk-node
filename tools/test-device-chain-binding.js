'use strict';
/**
 * 离线自测：设备链「绑定 + 粘贴优先」链路（不打网络、不碰 data/ 下的真实库）。
 *
 * 覆盖：
 *  1. 老库补列（ALTER TABLE 迁移）—— 老库没 device_chain_id 也能起；
 *  2. 粘贴文本里带 ks_* 时能被正确抽出；
 *  3. 设备链池 upsert 按 ks_deviceid 去重；
 *  4. applyDeviceChain 优先级：粘贴 > 账号指定 > 池轮换 > 同用户其它账号；
 *  5. 账号绑定 / 使用率统计 / 删除设备链后自动解绑；
 *  6. jobs.jarOf 会按账号指定把设备链覆盖到 jar 上。
 *
 * 跑法：node tools/test-device-chain-binding.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pknode-chain-'));
process.env.PK_DB = path.join(tmp, 'test.sqlite');
process.env.PK_SECRET = 'offline-test-secret-for-chain-binding-0123456789';

const { DatabaseSync } = require('node:sqlite');
const db = require('../src/db');
const leo = require('../src/leo');
const svc = require('../src/services/leo-accounts');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

/** 一段「真机整段复制」出来的 cookie：账号三件套 + 一大串别的 + 设备链。 */
const PASTE = [
  'sess=fake-sess-value;',
  'userid=1234567890;',
  'sid=aaaabbbb;',
  'g_sess=zzz;',
  'ysid=qqq;',
  'ymsToken=longtoken;',
  'ks_deviceid=DEVICE-PASTE-1111;',
  'ks_r=0.123;',
  'ks_u=9f8e7d;',
  'ks_sess=pastesess;',
  'ks_persistent=persistval;',
].join(' ');

/** 池里另外一份（自动轮换时会挑到它）。 */
const POOL_TEXT = 'ks_deviceid=DEVICE-POOL-2222; ks_r=0.9; ks_u=abc; ks_sess=poolsess; ks_persistent=pv';

function jarHasDeviceId(jar) {
  const c = jar.toJSON().find((x) => x.name === 'ks_deviceid');
  return c ? String(c.value || '') : '';
}

/* ------------------------- 1. 老库补列 ------------------------- */

console.log('\n[1] 老库迁移：leo_accounts 补 device_chain_id 列');
{
  // 先手搓一个「老结构」的库：建表语句里没有 device_chain_id
  const legacy = new DatabaseSync(process.env.PK_DB);
  legacy.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
      disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER);
    CREATE TABLE IF NOT EXISTS leo_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
      cookies_json TEXT NOT NULL, yfd_u TEXT, grade INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `);
  legacy.prepare(
    'INSERT INTO leo_accounts (user_id, name, cookies_json, yfd_u, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run(1, '老账号', JSON.stringify([{ name: 'sess', value: 'legacy' }]), '42', Date.now(), Date.now());
  legacy.close();

  db.init();
  const cols = db.get().prepare('PRAGMA table_info(leo_accounts)').all().map((c) => c.name);
  ok(cols.includes('device_chain_id'), '老库补出 device_chain_id 列');

  const row = db.get().prepare('SELECT * FROM leo_accounts LIMIT 1').get();
  ok(!!row && row.name === '老账号', '老库原有数据没被破坏');
  ok(row.device_chain_id == null, '老数据默认「不指定设备链」（自动）');
}

/* ------------------------- 2. 粘贴抽链 ------------------------- */

console.log('\n[2] 从粘贴文本里抽设备链');
{
  const chain = svc.extractDeviceChain(PASTE);
  ok(!!chain, '整段复制的 cookie 里认出了设备链');
  ok(chain && chain.some((c) => c.name === 'ks_deviceid' && c.value === 'DEVICE-PASTE-1111'), '抽出 ks_deviceid=DEVICE-PASTE-1111');
  ok(chain && chain.length === 5, '设备链 5 项（ks_* 全齐），实际 ' + (chain ? chain.length : 0));
  ok(svc.extractDeviceChain('sess=x; userid=1; sid=2') === null, '没有 ks_deviceid 时不算设备链');
}

/* ------------------------- 3. 池 upsert 去重 ------------------------- */

console.log('\n[3] 设备链池按 ks_deviceid 去重');
let poolIdA = 0;
let poolIdB = 0;
{
  const a = svc.autoPoolDeviceChain(PASTE, '粘贴来的链');
  poolIdA = a.id;
  ok(!!a && a.created === true, '首次粘贴 → 新建入库');

  const a2 = svc.autoPoolDeviceChain(PASTE, '粘贴来的链');
  ok(a2.id === poolIdA && a2.created === false, '同一 ks_deviceid 再存 → 更新而不是新增');

  const b = svc.autoPoolDeviceChain(POOL_TEXT, '池里的另一条');
  poolIdB = b.id;
  ok(poolIdB !== poolIdA, '另一条设备链是独立一行');
}

/* ------------------------- 4. 优先级 ------------------------- */

console.log('\n[4] applyDeviceChain 优先级：粘贴 > 账号指定 > 池轮换 > 同用户别的账号');
{
  // (a) 粘贴内容自带 → 就算池里/绑定都有别的，也用粘贴的
  const pasteChain = svc.extractDeviceChain(PASTE);
  const jarA = new leo.CookieJar([]);
  jarA.set({ name: 'sess', value: 'x', domain: '.yuanfudao.com', path: '/' });
  const rA = svc.applyDeviceChain(jarA, {
    pasteChain: pasteChain,
    pasteChainId: poolIdA,
    boundChainId: poolIdB,
    appUserId: 1,
  });
  ok(rA.from === 'paste' && jarHasDeviceId(jarA) === 'DEVICE-PASTE-1111', '粘贴内容的设备链赢');
  ok(rA.chainId === poolIdA, '返回值带上池里的 id（好回绑账号）');

  // (b) 没粘贴内容 → 用账号指定的那份，而不是池里随机那份
  const jarB = new leo.CookieJar([]);
  const rB = svc.applyDeviceChain(jarB, { boundChainId: poolIdB, appUserId: 1 });
  ok(rB.from === 'bound' && jarHasDeviceId(jarB) === 'DEVICE-POOL-2222', '账号指定优先于池轮换');

  // (c) 都没指定 → 池里挑（库里就那两条 enabled）
  const jarC = new leo.CookieJar([]);
  const rC = svc.applyDeviceChain(jarC, { appUserId: 1, pick: 1 });
  ok(rC.from === 'pool#' + poolIdB && jarHasDeviceId(jarC) === 'DEVICE-POOL-2222', '池轮换按 pick 取到第二条');

  // (d) 池里选中的那条不存在（被删了）→ 不该抛，往下走
  const jarD = new leo.CookieJar([]);
  const rD = svc.applyDeviceChain(jarD, { boundChainId: 999999, appUserId: 1, pick: 0 });
  ok(rD.applied === true && rD.from === 'pool#' + poolIdA, '绑定失效时回落到池轮换');
}

/* ------------------------- 5. 绑定 / 解绑 / 统计 ------------------------- */

console.log('\n[5] 账号绑定设备链');
let accId = 0;
{
  accId = db.addLeoAccount(1, '测试账号', [{ name: 'sess', value: 's1' }, { name: 'userid', value: '7' }], { yfdU: '7' });
  ok(db.getLeoAccountChainId(accId) === null, '新账号默认不指定设备链');

  db.setLeoAccountChain(accId, poolIdA);
  ok(db.getLeoAccountChainId(accId) === poolIdA, '绑定成功（getLeoAccountChainId 读回）');
  ok(db.getLeoAccount(accId).device_chain_id === poolIdA, 'getLeoAccount 也带上 device_chain_id');

  let threw = false;
  try { db.setLeoAccountChain(accId, 987654); } catch (e) { threw = true; }
  ok(threw, '绑到不存在的设备链 → 抛错（不让脏 id 落库）');

  db.setLeoAccountChain(accId, '');
  ok(db.getLeoAccountChainId(accId) === null, "传 '' / 'auto' 视为「不指定」");

  const usage = db.chainUsageMap();
  ok(usage[String(poolIdA)] === undefined, '没人绑它 → 使用数为 0');
  db.setLeoAccountChain(accId, poolIdA);
  ok(db.chainUsageMap()[String(poolIdA)] === 1, '使用率统计数出 1 个账号在用');
}

console.log('\n[6] 删链 → 绑定自动清空（退回自动）');
{
  db.deleteDeviceChain(poolIdA);
  ok(db.getDeviceChain(poolIdA) === null, '设备链已删除');
  ok(db.getLeoAccountChainId(accId) === null, '原绑定它的账号回到「自动」');
}

/* ------------------------- 7. jarOf 按绑定补齐 ------------------------- */

console.log('\n[7] 跑任务时按账号指定补齐设备链');
{
  const jobs = require('../src/jobs');
  const boundPool = svc.autoPoolDeviceChain(POOL_TEXT, '池里的另一条');
  db.setLeoAccountChain(accId, boundPool.id);

  const acc = db.getLeoAccount(accId);
  const jar = jobs.jarOf(acc);
  ok(jarHasDeviceId(jar) === 'DEVICE-POOL-2222', 'jarOf 把指定设备链盖到 jar 上');
  ok(!!jar.toJSON().find((c) => c.name === 'sess' && c.value === 's1'), '账号原有的 sess 没被顶掉');

  // 没指定（绑的是已删/不存在的）→ 原样返回，任务不该起不来
  db.setLeoAccountChain(accId, null);
  const acc2 = db.getLeoAccount(accId);
  const jar2 = jobs.jarOf(acc2);
  ok(jarHasDeviceId(jar2) === '', '未指定设备链时 jarOf 不硬塞（保持原样）');
}

/* ------------------------- 8. 导入链路（模拟 importAccount 的纯本地部分） ------------------------- */

console.log('\n[8] 导入时「粘贴内容自带设备链 → 收池 → 绑到该账号」');
{
  const before = db.listDeviceChains(false).length;
  const parsed = svc.parseCookieInput(PASTE);
  ok(parsed.ok, '粘贴文本解析通过（最少 sess/userid/sid 三组也能过）');

  const jar = parsed.jar;
  const pasteChain = svc.extractChainFromItems(jar.toJSON());
  const pooled = svc.autoPoolDeviceChain(pasteChain, '设备链 ' + svc.deviceIdOf(pasteChain));
  const chainInfo = svc.applyDeviceChain(jar, { pasteChain: pasteChain, pasteChainId: pooled.id, appUserId: 1 });
  const newId = db.addLeoAccount(1, '粘贴导入的账号', jar.toJSON().filter((c) => String(c.value || '').length > 0), {});
  if (chainInfo.chainId) db.setLeoAccountChain(newId, chainInfo.chainId);

  ok(db.listDeviceChains(false).length === before + 1, '粘贴里的设备链自动进池（同一 ks_deviceid 复用旧行）');
  const acc = db.getLeoAccount(newId);
  ok(acc.device_chain_id === pooled.id, '新账号绑定到这条粘贴设备链');
  // names 明文、value 加密 → 名字直接从库里那份 JSON 读
  const ks = JSON.parse(acc.cookies_json).map((c) => c.name).filter((n) => n.indexOf('ks_') === 0);
  ok(ks.length === 5, '落库 cookie 里带着完整设备链（' + ks.length + ' 项 ks_*）');

  // 再跑一次同一段粘贴（更新同一账号）→ 不该新增池条目
  const before2 = db.listDeviceChains(false).length;
  const parsed2 = svc.parseCookieInput(PASTE);
  const pooled2 = svc.autoPoolDeviceChain(svc.extractChainFromItems(parsed2.jar.toJSON()));
  ok(pooled2.id === pooled.id && pooled2.created === false, '重复导入同一设备链 → 池里不长大');
}

// sqlite 句柄还开着（模块没导出 close），删不掉也无所谓 —— 临时目录系统自己回收
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
