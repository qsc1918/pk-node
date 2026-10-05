'use strict';
/**
 * ws-raw.js —— 用 node:https 的 upgrade 事件手写 WS 客户端（完全掌控握手头）。
 * 验证「原生 https upgrade」这条路是否比 undici WebSocket 更可行。
 *
 * 用法：
 *   node tools/ws-raw.js match [leoId]    # 匹配通道：连上 → SESSION_READY → 发 MATCH_REQUEST → 打印结果
 */
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));

const db = require('../src/db');
const jobs = require('../src/jobs');
const ss = require('../src/school-season');
db.init();

const accId = Number(process.argv[3] || 6);
let acc = null;
for (const u of db.listUsers()) {
  const hit = db.listLeoAccounts(u.id).find((a) => Number(a.id) === accId);
  if (hit) { acc = hit; break; }
}
if (!acc) { console.error('账号不存在'); process.exit(2); }
const jar = jobs.jarOf(acc);

/* ---------------- 极简 WS 帧工具 ---------------- */

function wsEncodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x81;
    header[1] = 0x80 | len;
    const mask = crypto.randomBytes(4);
    mask.copy(header, 2);
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    return Buffer.concat([header, payload]);
  }
  if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    const mask = crypto.randomBytes(4);
    mask.copy(header, 4);
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    return Buffer.concat([header, payload]);
  }
  header = Buffer.alloc(14);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(len), 2);
  const mask = crypto.randomBytes(4);
  mask.copy(header, 10);
  for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
  return Buffer.concat([header, payload]);
}

function wsDecode(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let hlen = 2;
    if (len === 126) { if (off + 4 > buf.length) break; len = buf.readUInt16BE(off + 2); hlen = 4; }
    else if (len === 127) { if (off + 10 > buf.length) break; len = Number(buf.readBigUInt64BE(off + 2)); hlen = 10; }
    let maskKey = null;
    if (masked) { if (off + hlen + 4 > buf.length) break; maskKey = buf.subarray(off + hlen, off + hlen + 4); hlen += 4; }
    if (off + hlen + len > buf.length) break;
    const payload = Buffer.from(buf.subarray(off + hlen, off + hlen + len));
    if (maskKey) for (let i = 0; i < len; i++) payload[i] ^= maskKey[i & 3];
    frames.push({ opcode, payload });
    off += hlen + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/* ---------------- 单次连接（干净版） ---------------- */

function wsConnect(url, headers, handlers) {
  const u = new URL(url);
  const req = https.request({
    hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
    method: 'GET',
    headers: Object.assign({
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      Host: u.host,
    }, headers || {}),
    timeout: 15000,
  });
  req.on('upgrade', (res, socket) => {
    let accBuf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      accBuf = Buffer.concat([accBuf, chunk]);
      const { frames, rest } = wsDecode(accBuf);
      accBuf = rest;
      for (const f of frames) {
        if (f.opcode === 0x1 && handlers.onText) handlers.onText(f.payload.toString('utf8'));
        else if (f.opcode === 0x8) { console.log('[ws] server close'); socket.destroy(); }
      }
    });
    socket.on('close', () => { if (handlers.onClose) handlers.onClose(); });
    socket.on('error', (e) => console.log('[ws] socket err', e.message));
    handlers.onOpen({
      send: (obj) => socket.write(wsEncodeText(typeof obj === 'string' ? obj : JSON.stringify(obj))),
      close: () => { try { socket.destroy(); } catch (e) { /* ignore */ } },
    });
  });
  req.on('response', (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      console.log('[ws] HTTP', res.statusCode, 'block=', res.headers['x-block-by'] || '');
      console.log(Buffer.concat(chunks).toString('utf8').slice(0, 300));
      process.exit(1);
    });
  });
  req.on('timeout', () => { console.log('[ws] timeout'); req.destroy(); process.exit(1); });
  req.on('error', (e) => { console.log('[ws] err', e.message); process.exit(1); });
  req.end();
}

/* ---------------- 主流程 ---------------- */

(async () => {
  const h = await ss.home(jar, { grade: acc.grade || 2 });
  if (!h.json) { console.error('home 失败', h.status); process.exit(1); }
  const point = h.json.points[0];
  const traceId = ss.randomTraceId19();
  const url = ss.buildWsUrl('/game/match/v2', { sessionId: String(h.json.gameSessionId || 0), traceId });
  console.log('url:', url.slice(0, 170));

  let gen = null;
  let reqSeq = 0;
  let send = null;
  const frame = (type, data) => {
    reqSeq++;
    const f = { v: 2, type, reqId: 'pk-' + Date.now().toString(36) + '-' + reqSeq, gen, ts: Date.now() };
    if (data !== undefined) f.data = data;
    console.log('>>', JSON.stringify(f).slice(0, 220));
    if (send) send(f);
  };

  wsConnect(url, {
    Origin: 'https://xyks.yuanfudao.com',
    Cookie: jar.headerFor('xyks.yuanfudao.com', '/'),
    'User-Agent': 'Mozilla/5.0 (Linux; Android 15; DCO-AL00 Build/V417IR; wv) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 Mobile Safari/537.36 YuanSouTiKouSuan/3.143.1',
  }, {
    onOpen: (conn) => {
      console.log('[ws] UPGRADED');
      send = conn.send;
      setInterval(() => { if (gen != null) frame(1); }, 3000);
      setTimeout(() => { console.log('[ws] done'); conn.close(); process.exit(0); }, 25000);
    },
    onText: (t) => {
      console.log('<<', t.slice(0, 400));
      let m;
      try { m = JSON.parse(t); } catch (e) { return; }
      if (m.type === 4) {
        gen = m.gen;
        console.log('[ws] SESSION_READY gen=', gen);
        frame(11, { biz: 10, knowledgeId: point.pointId, questionCount: point.expectedQuestionCnt || 20 });
      }
    },
  });
})();