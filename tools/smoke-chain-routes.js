'use strict';
/**
 * 路由冒烟测试：本地起服务 + 临时库（不碰真实数据、不打网络），
 * 验证「账号指定使用哪份设备链」这条链路的接口是否真的通。
 *
 * 依赖环境变量（由调用方拼好）：
 *   PK_DB / PK_SECRET —— 指向一个临时库
 * 可选：SMOKE_BASE（默认 http://127.0.0.1:8899）、SMOKE_DB（服务器用的库路径，用于插一条占位账号）
 */

const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8899';
const SMOKE_DB = process.env.SMOKE_DB || process.env.PK_DB;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

async function call(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, Object.assign({ method: 'GET' }, opts));
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 160) }; }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') || '' };
}

async function main() {
  const user = 'smoke' + Date.now();
  const pass0 = 'Smoke-Pass-2026!';

  /* 1) 注册 + 登录 */
  const reg = await call('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass0 }),
  });
  const login = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass0 }),
  });
  // 会话 cookie 名见 config.sessionCookie（当前 pk_sid）
  const COOKIE_NAME = process.env.PK_SESSION_COOKIE || 'pk_sid';
  const token = (login.setCookie.match(new RegExp(COOKIE_NAME + '=([^;]+)')) || [])[1];
  ok(reg.status === 200 && !!token, '注册 + 登录拿到会话');
  const auth = { 'Content-Type': 'application/json', Cookie: COOKIE_NAME + '=' + token };

  /* 2) 往库里插一条「占位账号」（导入要走网络，这里绕开） */
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(SMOKE_DB);
  const uidRow = d.prepare('SELECT id FROM users WHERE username = ?').get(user);
  const now = Date.now();
  d.prepare(
    `INSERT INTO leo_accounts (user_id, name, cookies_json, yfd_u, grade, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(uidRow.id, '占位账号', JSON.stringify([{ name: 'sess', value: 'x' }]), '111', null, now, now);
  const accId = Number(d.prepare('SELECT last_insert_rowid() AS id').get().id);
  d.close();

  /* 3) 设备链池 */
  const CHAIN = 'ks_deviceid=SMOKE-DEVICE-0001; ks_r=0.5; ks_u=deadbeef; ks_sess=ss; ks_persistent=pp';
  const addChain = await call('/api/device-chains', {
    method: 'POST', headers: auth, body: JSON.stringify({ label: '冒烟链', cookie: CHAIN }),
  });
  ok(addChain.status === 200 && addChain.data.id > 0, 'POST /api/device-chains 塞进一份设备链');
  const chainId = Number(addChain.data.id);

  const listChains = await call('/api/device-chains', { headers: auth });
  const chainRow = (listChains.data.chains || []).find((c) => c.id === chainId);
  ok(!!chainRow && chainRow.useCount === 0, 'GET /api/device-chains 返回 useCount=0（还没人指定）');

  /* 4) 账号 → 设备链绑定 */
  let r = await call('/api/leo/accounts/' + accId + '/chain', {
    method: 'PUT', headers: auth, body: JSON.stringify({ deviceChainId: chainId }),
  });
  ok(r.status === 200 && Number(r.data.deviceChainId) === chainId, 'PUT /api/leo/accounts/:id/chain 指定设备链');

  const accList = await call('/api/leo/accounts', { headers: auth });
  const mine = (accList.data.accounts || []).find((a) => a.id === accId);
  ok(!!mine && Number(mine.deviceChainId) === chainId, 'GET /api/leo/accounts 回带 deviceChainId');

  const listChains2 = await call('/api/device-chains', { headers: auth });
  const chainRow2 = (listChains2.data.chains || []).find((c) => c.id === chainId);
  ok(Number(chainRow2.useCount) === 1, '指定之后 useCount 变成 1');

  /* 5) 绑到不存在的链 → 400 */
  r = await call('/api/leo/accounts/' + accId + '/chain', {
    method: 'PUT', headers: auth, body: JSON.stringify({ deviceChainId: 999999 }),
  });
  ok(r.status === 400 && r.data.ok === false, '绑到不存在的设备链 → 400 并给提示');

  /* 6) 清空绑定 → 回「自动」 */
  r = await call('/api/leo/accounts/' + accId + '/chain', {
    method: 'PUT', headers: auth, body: JSON.stringify({ deviceChainId: null }),
  });
  ok(r.status === 200 && r.data.deviceChainId === null, 'deviceChainId=null → 回到「自动」');

  /* 7) 别人的账号 → 404 */
  r = await call('/api/leo/accounts/999999/chain', {
    method: 'PUT', headers: auth, body: JSON.stringify({ deviceChainId: chainId }),
  });
  ok(r.status === 404, '给不存在的账号绑定 → 404');

  /* 8) 删链后绑定自动清空 */
  await call('/api/leo/accounts/' + accId + '/chain', {
    method: 'PUT', headers: auth, body: JSON.stringify({ deviceChainId: chainId }),
  });
  const del = await call('/api/device-chains/' + chainId, { method: 'DELETE', headers: auth });
  ok(del.status === 200, 'DELETE /api/device-chains/:id 成功');
  const listChains3 = await call('/api/device-chains', { headers: auth });
  ok(!(listChains3.data.chains || []).some((c) => c.id === chainId), '链已从池里消失');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
