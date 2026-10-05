'use strict';
/**
 * ws-diag.js —— 对 xyks 的 WS 握手做底层诊断（打印 HTTP 状态 / 响应头）。
 * 用 undici 的 raw 请求模拟 Upgrade，看服务端到底怎么回。
 */
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));

const db = require('../src/db');
const jobs = require('../src/jobs');
const ss = require('../src/school-season');
db.init();

const accId = Number(process.argv[2] || 6);
const users = db.listUsers();
let acc = null;
for (const u of users) {
  const hit = db.listLeoAccounts(u.id).find((a) => Number(a.id) === accId);
  if (hit) { acc = hit; break; }
}
if (!acc) { console.error('账号不存在'); process.exit(2); }
const jar = jobs.jarOf(acc);

const traceId = ss.randomTraceId19();
const fullUrl = 'wss://xyks.yuanfudao.com/leo-game-pk/api/game/match/v2?sessionId=1520&traceId=' + traceId;
const u = new URL(fullUrl.replace(/^wss:/, 'https:'));

const key = crypto.randomBytes(16).toString('base64');
const cookie = jar.headerFor('xyks.yuanfudao.com', '/');

const headers = {
  Connection: 'Upgrade',
  Upgrade: 'websocket',
  'Sec-WebSocket-Version': '13',
  'Sec-WebSocket-Key': key,
  Host: u.host,
  Origin: 'https://xyks.yuanfudao.com',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 15; DCO-AL00 Build/V417IR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 Mobile Safari/537.36 YuanSouTiKouSuan/3.143.1',
  Cookie: cookie,
  Referer: 'https://xyks.yuanfudao.com/bh5/leo-web-oral-pk/school-season-match.html',
};

const req = https.request({
  hostname: u.hostname,
  port: 443,
  path: u.pathname + u.search,
  method: 'GET',
  headers,
  timeout: 15000,
}, (res) => {
  console.log('=== HTTP STATUS:', res.statusCode);
  console.log('=== HEADERS:', JSON.stringify(res.headers, null, 2));
  const chunks = [];
  res.on('data', (d) => chunks.push(d));
  res.on('end', () => {
    const body = Buffer.concat(chunks);
    console.log('=== BODY (' + body.length + ' bytes):');
    console.log(body.toString('utf8').slice(0, 600));
    process.exit(0);
  });
});
req.on('upgrade', (res, socket) => {
  console.log('=== UPGRADE OK:', res.statusCode, JSON.stringify(res.headers));
  socket.destroy();
  process.exit(0);
});
req.on('timeout', () => { console.log('TIMEOUT'); req.destroy(); process.exit(1); });
req.on('error', (e) => { console.log('ERROR:', e.message); process.exit(1); });
req.end();