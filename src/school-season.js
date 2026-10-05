'use strict';
/**
 * 开学季竞速（school-season / 2026autumnRace）协议层 —— 纯 Node 复刻「匹配 → 对战 → 提交」。
 *
 * 来源：对官方 H5（`school-season.html` / `school-season-match.html`）的逆向；
 * 与 `pk-h5-proxy` 的 H5 版是**同一条协议的两个消费端**（这里用 Node 直连 WS，不经浏览器）。
 *
 * # 链路总览（★ 全部实测跑通 2026-10-05）
 *
 * ```
 * ① GET  {LEO}/leo-game-pk/api/game/battle/v2/math/home   （活动主页：points/gameSessionId/activityEndTime）
 * ② WS   {WS}/leo-game-pk/api/game/match/v2?<公共参数+sign>&sessionId=&traceId=
 *        → send(MATCH_REQUEST=11) {biz:10, knowledgeId, questionCount}
 *        ← recv(MATCH_REQUEST_ACK=12) {accepted, state:"JOINED", seat}
 *        ← recv(MATCH_ROOM_UPDATE=18) 机器人逐个补位 count 1→8 → LOCKED
 *        ← recv(MATCH_RESULT=15)  {found:true, battleId, battleTicket, question:{setId,version,detailPath,hash}, room}
 *        ← recv(MATCH_RESULT_CONFIRM=17) {battleId, startAt, readyDeadlineAt, battleDeadlineAt}
 * ③ WS   {WS}/leo-game-pk/api/game/battle/v2?<公共参数+sign>&battleId=&battleTicket=&traceId=
 *        → send(MATCH_RESULT_ACK=16) {battleId}          （确认入场）
 *        → send(BATTLE_READY=21) {battleId, setId, questionVersion, contentHash}
 *        ← recv(QUESTION_START=22) {battleId, qNo, startAt, qStartAt}
 * ④ GET  {detailPath}?battleId=   （arraybuffer + X-Battle-Ticket）
 *        → keystream XOR + gunzip → JSON {questions:[{qNo, content, sample, ruleType}]}
 * ⑤ → send(ANSWER=31) {qNo, answer}   （**costTime 由服务端按 qStartAt 计时，帧里没有 costTime**）
 *        ← recv(ANSWER_ACK=32) {qNo, result, done, rank, correctAnswer, score, state}
 * ⑥ ← recv(BATTLE_FINISH=23) 结算
 * ```
 *
 * # 帧格式（v2）
 *
 * `{v:2, type, reqId, gen, ts, data?, rid?, rv?}`
 *  - `gen` = SESSION_READY(4) 下发的 `gen`（连接代数，重连会 +1）；
 *  - 心跳：`PING(1)`/`PONG(2)`，间隔用 SESSION_READY 里的 `heartbeatIntervalMs`（3000）。
 *
 * # ★ 417 的关键教训（2026-10-05 实测）
 *
 * WS 握手 URL **必须带公共参数 + sign**（`_productId/platform/version/...&sign=`）。
 * 只带 `?sessionId=&traceId=` 会被 solar-encoder 417。`{client}` 占位符替换为 `api`。
 *
 * # ★ WS 客户端为什么手写而不用全局 WebSocket
 *
 * Node 内置的 undici WebSocket 在本环境对 `wss://xyks.yuanfudao.com` 握手失败
 * （连不上/onerror），而**原生 `https.request + upgrade 事件`手写帧可 100% 连接**
 * （实测 `tools/ws-raw.js` 全流程通过）。故这里用 `node:https` 自实现 RFC6455
 * 客户端帧收发（零依赖，与 pk-node 的「零外部依赖」原则一致）。
 *
 * # 「提交时间」怎么来的
 *
 * ANSWER 帧里**没有** costTime —— 服务端用 `qStartAt`（QUESTION_START 下发）到 ANSWER 到达的
 * 时间差记本题 costTime。所以「自定义提交时间」= 收到 QUESTION_START 后延迟多久发 ANSWER。
 *
 * # ★ 「贴限模式」（aimCostMode，2026-10-05）
 *
 * 榜单有「上榜下限」：低于它的成绩被判异常不上榜（`self.rank=999`），**每个榜不同**
 * （实测 2035=4900 / 2037=5600 / 2036=7000ms，恰为该榜榜一值）。服务端按物理时间
 * 计时（帧 ts 无法干预，已实验证伪）。「抢榜」= 精确贴着下限提交：读榜一 → target=榜一+safety
 * → delay=target/N-184ms（每题固定开销实测 ≈184ms）。实测 306ms/题 → 4900ms → rank=1。
 */

const https = require('node:https');
const crypto = require('node:crypto');
const { URLSearchParams } = require('node:url');
const { config, PK } = require('./config');
const { request } = require('./http');
const nativeLib = require('./native');
const pkH5 = require('./pk-h5-proxy');
const zlib = require('node:zlib');

/* ------------------------------------------------------------------ 常量 */

/** WS 主机（官方 request 模块里逐字：https→wss）。 */
const WS_HOST = 'wss://xyks.yuanfudao.com';
/** 主域（HTTP）主机。 */
const LEO_HOST = config.leoBase;

/** 消息类型枚举（H5 逐字：ma 对象）。 */
const MSG = {
  PING: 1, PONG: 2, ERROR: 3, SESSION_READY: 4,
  MATCH_REQUEST: 11, MATCH_REQUEST_ACK: 12, MATCH_CANCEL: 13, MATCH_CANCEL_ACK: 14,
  MATCH_RESULT: 15, MATCH_RESULT_ACK: 16, MATCH_RESULT_CONFIRM: 17,
  MATCH_ROOM_UPDATE: 18, MATCH_ROOM_REQUEST: 19,
  BATTLE_READY: 21, QUESTION_START: 22, BATTLE_FINISH: 23,
  ANSWER: 31, ANSWER_ACK: 32, GIVE_UP: 33, GIVE_UP_ACK: 34,
  BATTLE_PROGRESS: 41, PARTICIPANT_OFFLINE: 43, PARTICIPANT_ONLINE: 45,
  GAME_PROGRESS_REQUEST: 51, GAME_PROGRESS_RESULT: 52,
};

/** `biz:10` = 数学（school-season 对战）。 */
const BIZ_MATH = 10;

/* ------------------------------------------------------------------ 工具 */

/** `SchoolSeasonTrace` 的 19 位 traceId：`/^[0-9a-z]{19}$/`。 */
function randomTraceId19() {
  const c = '0123456789abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 19; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

/** 通用 20 位 [a-z0-9] traceId（HTTP 请求头用）。 */
function randomTraceId() {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 20; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

/** 官方 `SchoolSeasonTrace`（D5uPAvw7.js）逐字。 */
function traceHeader(traceId) {
  const b = (s) => Buffer.from(s, 'utf8').toString('base64');
  return ['1', b(traceId), b('0'), '0', b('__O_R_T__'), b('P_I'), b('P_E'), b('I_P')].join('-');
}

/** 通用 SW8（用于 default-namespace-sw8）。 */
function sw8(traceId) {
  const b = (s) => Buffer.from(s, 'utf8').toString('base64');
  return b('1') + '-' + b(traceId) + '-' + b('0') + '-0-X19PX1JfVF9f-UF9J-UF9F-SV9Q';
}

/** 主域 App 原生 UA（与 leo.js 同款）。 */
function nativeUa() {
  const d = config.device;
  return 'Leo/' + PK.commonQuery.version +
    ' (' + d.brand + d.model + '; Android ' + d.sdk + '; Scale/' + d.scale + ')';
}

/** H5 WebView UA（WS 握手实测可用的那套）。 */
const H5_UA = 'Mozilla/5.0 (Linux; Android 15; DCO-AL00 Build/V417IR; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 Mobile Safari/537.36 ' +
  'YuanSouTiKouSuan/' + PK.commonQuery.version;

/** 主域请求头（H5 抓包逐字 + x-shepherd-did）。 */
function commonHeaders(traceId) {
  const tid = traceId || randomTraceId();
  const h = {
    'User-Agent': nativeUa(),
    'leo-client-trace-id': tid,
    'default-namespace-sw8': sw8(tid),
    'X-XYKS-REQ-TIMESTAMP': String(Date.now()),
    'X-XYKS-REQ-NETWORK-ENV': 'mobile',
    'x-shepherd-sessionid': '0',
    Referer: LEO_HOST + '/bh5/leo-web-oral-pk/school-season.html',
    Origin: LEO_HOST,
  };
  if (config.shepherdDid) h['x-shepherd-did'] = config.shepherdDid;
  return h;
}

/** WS 握手头（实测通过的那套：Cookie + Origin + H5 UA）。 */
function wsHeaders(jar) {
  return {
    Cookie: jar.headerFor('xyks.yuanfudao.com', '/'),
    Origin: LEO_HOST,
    'User-Agent': H5_UA,
  };
}

/** 主域公共参数（PK 系）。 */
function commonQueryPairs() {
  return [['platform', PK.commonQuery.platform], ['version', PK.commonQuery.version],
    ['vendor', PK.commonQuery.vendor], ['av', PK.commonQuery.av],
    ['deviceCategory', PK.commonQuery.deviceCategory], ['webviewVersion', PK.commonQuery.webviewVersion],
    ['whRatio', PK.commonQuery.whRatio]];
}

/**
 * 组装 HTTP URL（带公共参数 + sign）。
 * school-season 属 PK 资产系（`/leo-game-pk`），用 pk 变体签名。
 */
function buildUrl(urlPath, params, opts) {
  const o = opts || {};
  const q = new URLSearchParams();
  q.set('_productId', o.productId || PK.productIdPk);
  if (o.appId) q.set('_appId', o.appId);
  const common = o.mainDomain
    ? [['platform', PK.exercise.platform], ['version', PK.exercise.version], ['vendor', PK.exercise.vendor],
       ['av', PK.exercise.av], ['deviceCategory', PK.exercise.deviceCategory],
       ['webviewVersion', PK.exercise.webviewVersion], ['whRatio', PK.exercise.whRatio],
       ['isBackground', PK.exercise.isBackground]]
    : commonQueryPairs();
  for (const [k, v] of common) q.set(k, v);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    q.set(k, String(v));
  }
  appendSign(q, urlPath);
  return LEO_HOST + urlPath + '?' + q.toString();
}

/**
 * 组装 WS 的完整 URL（**必须带公共参数 + sign**，否则被 solar-encoder 417）。
 *
 * ★ 2026-10-05 实测（ws-diag2.js 穷举 12 组合）：
 *   不带公共参数的 `?sessionId=&traceId=` 被 417（x-block-by: solar-encoder）；
 *   补全后 **101 Switching Protocols**。`{client}` → `api`。
 */
function buildWsUrl(wsPath, params) {
  const encodedPath = '/leo-game-pk/api' + wsPath;
  const q = new URLSearchParams();
  q.set('_productId', PK.productIdPk);
  for (const [k, v] of commonQueryPairs()) q.set(k, v);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    q.set(k, String(v));
  }
  appendSign(q, encodedPath);
  return WS_HOST + encodedPath + '?' + q.toString();
}

/** sign（pk 变体；算不出静默降级——但 WS 需要它，建议保持 PK_SIGN_MODE=auto）。 */
function appendSign(q, encodedPath) {
  try {
    const mode = String(config.signMode || 'off').toLowerCase();
    if (mode === 'off') return;
    const sign = nativeLib.calcSign(encodedPath, { variant: 'pk' });
    if (sign) q.set('sign', sign);
  } catch (e) { /* ignore */ }
}

function safeJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }

function abortedError() {
  const e = new Error('已中断');
  e.aborted = true;
  return e;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortedError());
    const t = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
    let onAbort;
    function cleanup() { clearTimeout(t); if (onAbort) signal.removeEventListener('abort', onAbort); }
    if (signal) {
      onAbort = () => { cleanup(); reject(abortedError()); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/* ------------------------------------------------------------------ HTTP 接口 */

/** `GET /leo-game-pk/api/game/battle/v2/math/home` —— 活动主页。 */
async function home(jar, opts) {
  const o = opts || {};
  const path = '/leo-game-pk/api/game/battle/v2/math/home';
  // ★ grade 必须 > 0：实测传 0 会返回空 points（服务端按有效年级过滤）。
  const grade = Number(o.grade) > 0 ? Number(o.grade) : 2;
  const url = buildUrl(path, { grade: grade });
  const r = await request({
    url, method: 'GET', jar, signal: o.signal,
    headers: Object.assign({ Accept: 'application/json, text/plain, */*' }, commonHeaders()),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/**
 * `GET /leo-game-pk/api/game/battle/v2/math/rank` —— 榜单。
 * @param {object} o {pointId, scope: 1=全国|2=城市, lat, lng}
 */
async function rank(jar, o) {
  const opts = o || {};
  const path = '/leo-game-pk/api/game/battle/v2/math/rank';
  const params = { pointId: opts.pointId };
  if (opts.scope != null) params.scope = opts.scope;
  if (opts.lat != null) params.lat = opts.lat;
  if (opts.lng != null) params.lng = opts.lng;
  const url = buildUrl(path, params);
  const r = await request({
    url, method: 'GET', jar, signal: opts.signal,
    headers: Object.assign({ Accept: 'application/json, text/plain, */*' }, commonHeaders()),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/**
 * 对局题目：`GET {detailPath}?battleId=`（arraybuffer）。
 * `detailPath` 由 MATCH_RESULT 的 `question.detailPath` 给出（服务端动态路径）。
 */
async function battleDetail(jar, o) {
  const opts = o || {};
  const base = String(opts.host || LEO_HOST).trim().replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/+$/, '');
  const pathPart = String(opts.detailPath || '');
  if (pathPart.charAt(0) !== '/' || pathPart.slice(0, 2) === '//') {
    throw new Error('detailPath 非法：' + pathPart);
  }
  const path = pathPart.replace(/\{client\}/g, 'api');
  const url = base + path
    + '?' + new URLSearchParams({ battleId: String(opts.battleId) }).toString();
  const headers = commonHeaders(opts.traceId);
  headers['X-Battle-Ticket'] = String(opts.battleTicket || '');
  headers.Accept = 'application/octet-stream';
  const r = await request({
    url, method: 'GET', jar, rawBody: true, signal: opts.signal, headers,
  });
  return { status: r.status, body: r.body, headers: r.headers };
}

/** 解密「对战题目」响应：密文 → keystream XOR → gunzip → JSON。 */
function decodeBattleDetail(buf) {
  if (!buf || buf.length < 2) return null;
  if (buf[0] === 0x7b || buf[0] === 0x5b) return safeJson(buf.toString('utf8'));
  const dec = pkH5.decryptBuffer(buf);
  if (dec) return safeJson(dec.toString('utf8'));
  try { return safeJson(zlib.gunzipSync(buf).toString('utf8')); } catch (e) { return null; }
}

/* ------------------------------------------------------------------ WS 客户端（原生 https 实现） */

/**
 * RFC6455 帧编码（客户端→服务端必须加掩码）。
 */
function wsEncodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  if (len < 126) {
    const header = Buffer.alloc(6);
    header[0] = 0x81;
    header[1] = 0x80 | len;
    const mask = crypto.randomBytes(4);
    mask.copy(header, 2);
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    return Buffer.concat([header, payload]);
  }
  if (len < 65536) {
    const header = Buffer.alloc(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    const mask = crypto.randomBytes(4);
    mask.copy(header, 4);
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(14);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(len), 2);
  const mask = crypto.randomBytes(4);
  mask.copy(header, 10);
  for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
  return Buffer.concat([header, payload]);
}

/** 帧解码（服务端→客户端不加掩码；兼容带掩码的异常实现）。 */
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
    if (len === 126) {
      if (off + 4 > buf.length) break;
      len = buf.readUInt16BE(off + 2);
      hlen = 4;
    } else if (len === 127) {
      if (off + 10 > buf.length) break;
      len = Number(buf.readBigUInt64BE(off + 2));
      hlen = 10;
    }
    let maskKey = null;
    if (masked) {
      if (off + hlen + 4 > buf.length) break;
      maskKey = buf.subarray(off + hlen, off + hlen + 4);
      hlen += 4;
    }
    if (off + hlen + len > buf.length) break;
    const payload = Buffer.from(buf.subarray(off + hlen, off + hlen + len));
    if (maskKey) for (let i = 0; i < len; i++) payload[i] ^= maskKey[i & 3];
    frames.push({ opcode, payload });
    off += hlen + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/**
 * 极简 WS 客户端（node:https upgrade + 手写帧）。
 *
 * 为什么不用全局 `WebSocket`：undici 实现对 xyks 的 wss 握手失败（实测），
 * 而原生 https upgrade 100% 可连。详见文件头注释。
 */
class WsClient {
  /**
   * @param {object} o {url, headers, logPrefix, onMessage, onState}
   */
  constructor(o) {
    this.url = o.url;
    this.headers = o.headers || {};
    this.logPrefix = o.logPrefix || 'WS';
    this.onMessage = o.onMessage || (() => {});
    this.onState = o.onState || (() => {});
    this.socket = null;
    this.gen = null;
    this.reqSeq = 0;
    this.heartbeatTimer = null;
    this.heartbeatIntervalMs = 3000;
    this.closed = false;
    this.buf = Buffer.alloc(0);
  }

  /** 连上并等到 SESSION_READY（resolve gen），或超时 reject。 */
  connect(readyTimeoutMs) {
    const self = this;
    return new Promise((resolve, reject) => {
      let done = false;
      const u = new URL(this.url);
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(this.logPrefix + ' 连接超时（SESSION_READY 未到）'));
        try { if (self.socket) self.socket.destroy(); } catch (e) { /* ignore */ }
      }, readyTimeoutMs || 15000);

      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: Object.assign({
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          Host: u.host,
        }, this.headers),
        timeout: (readyTimeoutMs || 15000) + 5000,
      });

      this.req = req;

      req.on('upgrade', (res, socket) => {
        this.socket = socket;
        self.onState('open');
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 5000);
        socket.on('data', (chunk) => {
          self.buf = Buffer.concat([self.buf, chunk]);
          const { frames, rest } = wsDecode(self.buf);
          self.buf = rest;
          for (const f of frames) {
            if (f.opcode === 0x1) {
              let msg = null;
              try { msg = JSON.parse(f.payload.toString('utf8')); } catch (e) { continue; }
              if (!msg || typeof msg !== 'object') continue;
              if (msg.type === MSG.SESSION_READY) {
                self.gen = msg.gen != null ? msg.gen : null;
                if (msg.data && msg.data.heartbeatIntervalMs) {
                  self.heartbeatIntervalMs = msg.data.heartbeatIntervalMs;
                }
                self.startHeartbeat();
                if (!done) { done = true; clearTimeout(timer); resolve(self.gen); }
              }
              self.onMessage(msg);
            } else if (f.opcode === 0x8) {
              // 服务端关闭
              try { socket.destroy(); } catch (e) { /* ignore */ }
            } else if (f.opcode === 0x9) {
              // ping → 回 pong（opcode 0xA）
              try {
                const pong = Buffer.concat([Buffer.from([0x8a]), f.payload]);
                socket.write(pong);
              } catch (e) { /* ignore */ }
            }
          }
        });
        socket.on('close', () => {
          self.stopHeartbeat();
          self.onState('closed');
        });
        socket.on('error', () => { /* 关闭时忽略 */ });
      });

      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            reject(new Error(self.logPrefix + ' 握手被拒 HTTP ' + res.statusCode +
              ' block=' + (res.headers['x-block-by'] || '-')));
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        if (!done) { done = true; clearTimeout(timer); reject(new Error(self.logPrefix + ' 请求超时')); }
      });
      req.on('error', (e) => {
        if (!done) { done = true; clearTimeout(timer); reject(new Error(self.logPrefix + ' 连接失败：' + e.message)); }
      });
      req.end();
    });
  }

  startHeartbeat() {
    const self = this;
    this.stopHeartbeat();
    this.sendPing();
    this.heartbeatTimer = setInterval(() => { self.sendPing(); }, this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  sendPing() {
    try { this.send(MSG.PING); } catch (e) { /* ignore */ }
  }

  nextReqId() {
    this.reqSeq += 1;
    return 'pk-' + Date.now().toString(36) + '-' + this.reqSeq.toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  /** 发送一帧。返回 reqId；未就绪时返回 null。 */
  send(type, data, extra) {
    const s = this.socket;
    if (!s || !s.writable || this.gen == null) return null;
    const reqId = (extra && extra.reqId) || this.nextReqId();
    const frame = { v: 2, type: type, reqId: reqId, gen: this.gen, ts: Date.now() };
    if (extra && extra.rid) frame.rid = extra.rid;
    if (extra && typeof extra.rv === 'number') frame.rv = extra.rv;
    // ★ 帧时间戳覆盖（复验用）：实验已证伪 —— 服务端按物理时间计时（qStartAt→到达），
    //   帧 ts 不影响 costTime，此开关保留仅供复验。
    if (extra && typeof extra.ts === 'number' && Number.isFinite(extra.ts)) frame.ts = extra.ts;
    if (data !== undefined) frame.data = data;
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text, 'utf8') > 65536) throw new Error('FRAME_TOO_LARGE');
    s.write(wsEncodeText(text));
    return reqId;
  }

  close() {
    this.closed = true;
    this.stopHeartbeat();
    try { if (this.socket) this.socket.destroy(); } catch (e) { /* ignore */ }
    try { if (this.req) this.req.destroy(); } catch (e) { /* ignore */ }
    this.socket = null;
  }
}

/* ------------------------------------------------------------------ 单局流程 */

/**
 * 从「对战通道」的可能消息里提取「是否已开赛」。
 *
 * 服务端在 CONFIRM → COUNTDOWN → RUNNING 之间可能通过 MATCH_ROOM_UPDATE(18) 或
 * QUESTION_START(22) 推状态。**ANSWER 只有 RUNNING 之后才被接受**（否则
 * 回 `BATTLE_NOT_STARTED`）—— 所以主循环必须过一道「开赛门」。
 */
function isRunningUpdate(msg) {
  if (msg.type === MSG.MATCH_ROOM_UPDATE && msg.data) {
    const st = msg.data.state;
    return st === 'RUNNING' || st === 'COUNTDOWN';
  }
  return false;
}

/**
 * 跑一局开学季竞速（完整链路：主页 → 匹配 → 对战 → 逐题作答 → 结算）。
 *
 * @param {object} jar
 * @param {object} cfg
 * @param {number} [cfg.pointId]            知识点 id（0=用主页第一个）
 * @param {number} [cfg.questionCount]      题数（默认用知识点 expectedQuestionCnt）
 * @param {number} [cfg.grade]              年级
 * @param {number} [cfg.answerDelayMinMs]   每题提交前的延迟下限（自定义提交时间）
 * @param {number} [cfg.answerDelayMaxMs]   延迟上限
 * @param {boolean} [cfg.useSample]         true=抄 sample（默认），false=本地计算优先
 * @param {number} [cfg.battleMaxMs]        单局总超时
 * @param {(ev:object)=>void} [onEvent]
 * @param {AbortSignal} [signal]
 */
async function runOneRace(jar, cfg, onEvent, signal) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const ensureLive = () => { if (signal && signal.aborted) throw abortedError(); };
  const t0 = Date.now();

  // 0) 活动主页
  emit({ type: 'ss-home', message: '拉取活动主页…' });
  const h = await home(jar, { grade: cfg.grade, signal });
  if (h.status !== 200 || !h.json) {
    return { ok: false, message: '活动主页失败 HTTP ' + h.status, detail: String(h.text || '').slice(0, 300) };
  }
  const homeData = h.json;
  if (homeData.bannedStat && Number(homeData.bannedStat) !== 0) {
    return { ok: false, message: '账号被禁赛（bannedStat=' + homeData.bannedStat + '）' };
  }
  const points = Array.isArray(homeData.points) ? homeData.points : [];
  if (points.length === 0) return { ok: false, message: '活动知识点为空（活动可能未开始）' };
  const point = points.find((p) => Number(p.pointId) === Number(cfg.pointId)) || points[0];
  const gameSessionId = homeData.gameSessionId || 0;
  const activityEndTime = homeData.activityEndTime || 0;
  if (activityEndTime && Date.now() > activityEndTime) {
    return { ok: false, message: '活动已结束（activityEndTime=' + activityEndTime + '）' };
  }
  const questionCount = Number(cfg.questionCount) > 0
    ? Number(cfg.questionCount)
    : (Number(point.expectedQuestionCnt) || 20);
  emit({
    type: 'ss-home-ok',
    message: `活动主页 OK：知识点「${point.pointName}」(${point.pointId})，题数 ${questionCount}，session=${gameSessionId}`,
  });

  // ★ 0.5) 贴限模式（aimCostMode）：读该榜榜一（= 上榜下限）→ 目标 costTime → 反推每题提交延迟。
  //
  //   背景（2026-10-05 实测）：每个榜有「上榜下限」，低于它的成绩被服务端判异常
  //   （self.rank=999，不上榜），且各榜不同（2035=4900 / 2037=5600 / 2036=7000，
  //   恰为该榜榜一值）。服务端按「qStartAt → ANSWER 到达」的物理时间计时
  //   （帧 ts 无法干预，已实验证伪）。因此「突破」= 精确贴着下限提交：
  //   目标 = 榜一 + safety，拿到「服务端可接受的最快成绩」，抢榜单前排。
  //
  //   模型（实测拟合，N=10 时误差 ±20ms）：costTime ≈ N × (delay + 184ms)
  //   （184ms = 每题固定开销：广播/网络/服务端处理），→ delay = target / N - 184。
  let aimInfo = null;
  let delayMinMs = cfg.answerDelayMinMs;
  let delayMaxMs = cfg.answerDelayMaxMs;
  if (cfg.aimCostMode) {
    const safety = Number(cfg.aimSafetyMs) >= 0 ? Number(cfg.aimSafetyMs) : 40;
    let base = null;
    try {
      const rk = await rank(jar, { pointId: point.pointId, scope: 1, signal });
      const ranks = (rk.json && rk.json.ranks) || [];
      const costs = ranks.map((x) => Number(x && x.costTime)).filter((x) => Number.isFinite(x) && x > 0);
      if (costs.length) base = Math.min.apply(null, costs);
    } catch (e) { /* 拉榜失败 → 用兜底值 */ }
    if (base == null) {
      base = Number(cfg.aimFallbackBaseMs) > 0 ? Number(cfg.aimFallbackBaseMs) : 4900;
      emit({ type: 'ss-aim', message: `贴限模式：本榜暂无可读榜一，用兜底下限 ${base}ms` });
    }
    const target = base + safety;
    const overhead = Number(cfg.aimOverheadMs) > 0 ? Number(cfg.aimOverheadMs) : 184;
    const perQ = Math.max(0, Math.round((target / Math.max(1, questionCount)) - overhead));
    delayMinMs = perQ;
    delayMaxMs = perQ;
    aimInfo = { base: base, target: target, delayMs: perQ, safety: safety, overhead: overhead };
    emit({
      type: 'ss-aim',
      message: `贴限模式：榜一 ${base}ms → 目标 ${target}ms → 每题延迟 ${perQ}ms（${questionCount} 题）`,
    });
  }

  ensureLive();

  // 1) 匹配 WS
  const traceId = randomTraceId19();
  const matchUrl = buildWsUrl('/game/match/v2', { sessionId: String(gameSessionId), traceId });
  emit({ type: 'ss-match', message: '连接匹配通道…' });

  let matchResult = null;
  let matchConfirmed = null;
  let mySeat = 0;           // 自己的座位号（MATCH_REQUEST_ACK 给出）
  const matchWs = new WsClient({
    url: matchUrl,
    headers: wsHeaders(jar),
    logPrefix: 'match',
    onMessage: (msg) => {
      if (msg.type === MSG.MATCH_RESULT && msg.data && msg.data.found) matchResult = msg.data;
      else if (msg.type === MSG.MATCH_RESULT_CONFIRM && msg.data) matchConfirmed = msg.data;
      else if (msg.type === MSG.MATCH_REQUEST_ACK && msg.data && msg.data.seat) {
        mySeat = Number(msg.data.seat);
        emit({ type: 'ss-seat', message: `已入座（seat=${mySeat}）` });
      } else if (msg.type === MSG.MATCH_ROOM_UPDATE && msg.data) {
        const st = msg.data.state;
        if (st === 'FILLING_SHADOW' && Number(msg.data.count) % 4 === 0) {
          emit({ type: 'ss-room', message: `匹配中… ${msg.data.count}/8 人就位` });
        }
        if (st === 'LOCKED') emit({ type: 'ss-room', message: '房间已锁定（8 人）' });
      } else if (msg.type === MSG.ERROR) {
        emit({ type: 'ss-warn', message: '匹配通道错误：' + JSON.stringify(msg.data || {}).slice(0, 200) });
      }
    },
  });

  try {
    await matchWs.connect(15000);
    ensureLive();
    const reqId = matchWs.send(MSG.MATCH_REQUEST, {
      biz: BIZ_MATH,
      knowledgeId: point.pointId,
      questionCount: questionCount,
    });
    if (!reqId) return { ok: false, message: '匹配请求发送失败（会话未就绪）' };
    emit({ type: 'ss-match-sent', message: `已请求匹配（knowledgeId=${point.pointId} 题数=${questionCount}），等待机器人补位…` });

    const matchDeadline = Date.now() + (cfg.matchMaxMs || 60000);
    while (!matchResult || !matchConfirmed) {
      ensureLive();
      if (Date.now() > matchDeadline) {
        return { ok: false, message: '匹配超时（' + Math.round((Date.now() - t0) / 1000) + 's 无结果）' };
      }
      await sleep(250, signal);
    }
    // 确认入场（16）
    try { matchWs.send(MSG.MATCH_RESULT_ACK, { battleId: matchResult.battleId }); } catch (e) { /* ignore */ }
    await sleep(500, signal);
  } finally {
    try { matchWs.close(); } catch (e) { /* ignore */ }
  }

  const battleId = String(matchResult.battleId || '');
  const battleTicket = String(matchResult.battleTicket || '');
  const question = matchResult.question || {};
  emit({
    type: 'ss-matched',
    message: `匹配成功：battleId=${battleId}，开赛于 ${matchConfirmed.startAt ? new Date(matchConfirmed.startAt).toLocaleTimeString() : '?'}`,
  });
  if (!battleId || !battleTicket) return { ok: false, message: 'MATCH_RESULT 缺 battleId/battleTicket' };
  ensureLive();

  // 2) 对战 WS
  const battleUrl = buildWsUrl('/game/battle/v2', { battleId, battleTicket, traceId });

  const state = {
    questions: null,
    currentQNo: 0,
    qStartAt: 0,
    answers: [],
    finished: false,
    finishData: null,
    lastAck: null,
    startedAt: Date.now(),
    lock: false,          // 是否已在处理一题（防并发答题）
    // ★ 开赛门（对齐 H5）：只有 roomState=RUNNING 之后才该发 ANSWER，
    //   否则服务端回 BATTLE_NOT_STARTED。gateUntil 期内不发题（等快照/重试）。
    roomState: null,
    readyAccepted: false,
    gateUntil: 0,
    lastSent: null,       // {qNo, answer} 最近一次已发未确认的答案
    lastProgressReqAt: 0,
  };
  const answered = new Set();
  const answerQueue = [];

  const battleWs = new WsClient({
    url: battleUrl,
    headers: wsHeaders(jar),
    logPrefix: 'battle',
    onMessage: (msg) => {
      switch (msg.type) {
        case MSG.MATCH_ROOM_UPDATE: {
          if (msg.data) {
            const st = msg.data.state;
            state.roomState = st || state.roomState;
            if (st === 'RUNNING' || st === 'COUNTDOWN') {
              emit({ type: 'ss-run', message: '已开赛（' + st + '）' });
            }
          }
          break;
        }
        case MSG.QUESTION_START: {
          const d = msg.data || {};
          if (d.qNo != null) {
            state.currentQNo = Number(d.qNo);
            state.qStartAt = d.qStartAt || 0;
            if (!answered.has(state.currentQNo)) answerQueue.push(state.currentQNo);
            emit({ type: 'ss-question', message: `第 ${state.currentQNo} 题开始（qStartAt=${state.qStartAt}）`, qNo: state.currentQNo });
          }
          break;
        }
        case MSG.ANSWER_ACK: {
          state.lastAck = msg.data || {};
          const a = state.lastAck;
          // 该题已被服务端接受 → 清「未确认」标记
          if (state.lastSent && state.lastSent.qNo === a.qNo) state.lastSent = null;
          emit({
            type: a.result === 'CORRECT' ? 'ss-ack-ok' : 'ss-ack',
            message: `第 ${a.qNo} 题 ACK：${a.result}（进度 ${a.done}${a.rank ? '，名次 ' + a.rank : ''}${a.correctAnswer != null ? '，正确答案 ' + a.correctAnswer : ''}）`,
            qNo: a.qNo,
          });
          break;
        }
        case MSG.BATTLE_FINISH: {
          state.finished = true;
          state.finishData = msg.data || {};
          break;
        }
        case MSG.ERROR: {
          const d = msg.data || {};
          state.lastError = d;
          // ★ BATTLE_NOT_STARTED：还没开赛就答了 → 把该题放回队列，等开赛门过了再发
          if (d.code === 'BATTLE_NOT_STARTED' && state.lastSent) {
            const back = state.lastSent;
            state.lastSent = null;
            answered.delete(back.qNo);
            answerQueue.unshift(back.qNo);
            state.gateUntil = Date.now() + 1500;
            emit({ type: 'ss-gate', message: `服务端尚未开赛，第 ${back.qNo} 题 1.5s 后重发`, qNo: back.qNo });
          } else {
            emit({ type: 'ss-warn', message: '对战错误：' + JSON.stringify(d).slice(0, 200) });
          }
          break;
        }
        default: break;
      }
    },
  });

  try {
    await battleWs.connect(15000);
    ensureLive();

    // 2.1) BATTLE_READY（注意：MATCH_RESULT_ACK 只发在 match 通道；battle 通道发它会被回 MESSAGE_NOT_SUPPORTED）
    const readyId = battleWs.send(MSG.BATTLE_READY, {
      battleId,
      setId: String(question.setId || ''),
      questionVersion: Number(question.version || 0),
      contentHash: String(question.hash || ''),
    });
    if (!readyId) return { ok: false, message: 'BATTLE_READY 发送失败' };
    emit({ type: 'ss-ready', message: '已就绪，等待开赛…' });

    // 2.2) 拉题目（与 H5 一致：ready 后立即拉）
    emit({ type: 'ss-detail', message: '拉取对战题目（arraybuffer → 解密）…' });
    const det = await battleDetail(jar, {
      detailPath: question.detailPath || '',
      battleId, battleTicket, traceId, signal,
    });
    if (det.status !== 200 || !det.body || det.body.length === 0) {
      return { ok: false, message: '对战题目拉取失败 HTTP ' + det.status, answers: state.answers };
    }
    const qjson = decodeBattleDetail(det.body);
    if (!qjson || !Array.isArray(qjson.questions)) {
      return { ok: false, message: '对战题目解密失败（' + det.body.length + ' bytes）', answers: state.answers };
    }
    state.questions = qjson.questions;
    emit({
      type: 'ss-detail-ok',
      message: `题目就绪：${qjson.questions.length} 题（首题「${String((qjson.questions[0] || {}).content || '').slice(0, 40)}」）`,
    });

    // 2.3) 主循环：QUESTION_START → （延迟）ANSWER → …→ BATTLE_FINISH
    //
    // ★ 开赛门：服务端在 startAt（MATCH_RESULT_CONFIRM 给出）之前会拒绝 ANSWER
    //   （回 BATTLE_NOT_STARTED）。这里用心跳/时钟兜底：若 startAt 已知，就等到它再答。
    const startAt = Number(matchConfirmed.startAt) || 0;
    if (startAt > Date.now()) {
      const waitMs = Math.min(startAt - Date.now() + 300, 20000);
      emit({ type: 'ss-countdown', message: `等待开赛（${(waitMs / 1000).toFixed(1)}s）…` });
      await sleep(waitMs, signal);
    }
    const battleDeadline = Date.now() + (cfg.battleMaxMs || 5 * 60 * 1000);
    let firstSendLogged = false;
    while (!state.finished) {
      ensureLive();
      if (Date.now() > battleDeadline) {
        return { ok: false, message: '对战超时（' + Math.round((Date.now() - state.startedAt) / 1000) + 's）', answers: state.answers };
      }
      if (answerQueue.length > 0 && !state.lock && Date.now() >= state.gateUntil) {
        state.lock = true;
        try {
          const qNo = answerQueue.shift();
          if (answered.has(qNo)) continue;
          const q = (state.questions || []).find((x) => Number(x.qNo) === qNo) || (state.questions || [])[qNo - 1];
          if (!q) {
            emit({ type: 'ss-warn', message: `题 ${qNo} 在题目缓存里找不到，跳过` });
            continue;
          }
          const answer = pickAnswer(q, cfg);
          // ★ 自定义提交时间：收到 QUESTION_START 后延迟发 ANSWER
          //   （贴限模式下 delayMinMs/delayMaxMs 是瞄准算出的值）
          const delay = randomDelay(delayMinMs, delayMaxMs);
          if (delay > 0) {
            emit({ type: 'ss-answer-wait', message: `第 ${qNo} 题等 ${(delay / 1000).toFixed(1)}s 后提交`, qNo, delayMs: delay });
            await sleep(delay, signal);
          }
          ensureLive();
          // ★ 帧 ts 复验开关（answerTsSkewMs）：已实验证伪（ts 不影响 costTime），保留仅供复验
          const skew = Number(cfg.answerTsSkewMs) || 0;
          const ansExtra = skew ? { ts: Date.now() + skew } : undefined;
          const rid = battleWs.send(MSG.ANSWER, { qNo, answer }, ansExtra);
          if (rid) {
            state.lastSent = { qNo, answer };
            if (!firstSendLogged) {
              firstSendLogged = true;
              emit({ type: 'ss-first-answer', message: `首题已发（第 ${qNo} 题）` });
            }
            answered.add(qNo);
            state.answers.push({ qNo, answer, sentAt: Date.now(), delayMs: delay });
            emit({ type: 'ss-answer', message: `已提交第 ${qNo} 题：${answer}`, qNo, answer, delayMs: delay, reqId: rid });
          }
        } finally {
          state.lock = false;
        }
        continue;
      }
      await sleep(100, signal);
    }

    // 3) 结算
    const fin = state.finishData || {};
    const players = Array.isArray(fin.players) ? fin.players : [];
    const mine = players.find((p) => Number(p.seat) === mySeat) || null;
    const okCount = state.answers.length;
    const myRank = mine && mine.rank != null ? mine.rank : (fin.self && fin.self.rank != null ? fin.self.rank : null);
    const myCost = mine && mine.costTime != null ? mine.costTime : null;
    emit({
      type: 'ss-finish',
      message: `对战结束：名次 ${myRank == null ? '?' : myRank}/8` +
        (myCost != null ? `，costTime=${myCost}ms` : '') + `，共提交 ${okCount} 题`,
    });

    // ★ 贴限核验（aimCostMode）：赛后查 self —— rank=999 表示被判异常（未上榜）。
    //   self 语义（实测）：显示「我的最佳成绩」+ 名次；从未成功则显示最近被拒成绩 + rank=999。
    let aimAccepted = null;
    let aimRank = null;
    let aimSelfCost = null;
    if (aimInfo && myCost != null) {
      try {
        await sleep(1500, signal);
        const rk2 = await rank(jar, { pointId: point.pointId, scope: 1 });
        const self = (rk2.json && rk2.json.self) || null;
        if (self && self.costTime != null) {
          aimSelfCost = Number(self.costTime);
          if (Number(self.rank) !== 999) {
            aimAccepted = true;
            aimRank = Number(self.rank);
            emit({ type: 'ss-aim-ok', message: `贴限核验：已上榜（我的最佳 ${aimSelfCost}ms，名次 ${aimRank}）` });
          } else if (Math.abs(aimSelfCost - Number(myCost)) <= 100) {
            aimAccepted = false;
            emit({ type: 'ss-aim-fail', message: `贴限核验：未上榜（${aimSelfCost}ms 被判异常 rank=999）` });
          } else {
            emit({ type: 'ss-aim-warn', message: `贴限核验：self=${aimSelfCost}ms/rank=${self.rank}` });
          }
        } else {
          emit({ type: 'ss-aim-warn', message: `贴限核验：self 暂未更新（本局 ${myCost}ms）` });
        }
      } catch (e) { /* 核验失败/中断不影响结算 */ }
    }
    // 名次/成绩摘要（存进 detail 供「任务明细」展示）
    const summary = players
      .slice()
      .sort((a, b) => (a.rank || 99) - (b.rank || 99))
      .map((p) => `#${p.rank} seat${p.seat} done=${p.done} cost=${p.costTime}ms`)
      .join('; ');
    return {
      ok: true,
      message: `单局完成（提交 ${okCount} 题，名次 ${myRank == null ? '?' : myRank}/8，耗时 ${Math.round((Date.now() - t0) / 1000)}s）`,
      battleId,
      finish: fin,
      rank: myRank,
      costTimeMs: myCost,
      aim: aimInfo,
      aimAccepted: aimAccepted,
      aimRank: aimRank,
      aimSelfCost: aimSelfCost,
      answers: state.answers,
      detail: '本局结算：' + summary,
    };
  } finally {
    try { battleWs.close(); } catch (e) { /* ignore */ }
  }
}

/** 从题目里挑答案：默认 sample 优先；cfg.useSample=false 时本地求解优先。 */
function pickAnswer(q, cfg) {
  if (cfg && cfg.useSample === false) {
    const local = solveLocally(q && q.content);
    if (local != null) return local;
  }
  if (q && q.sample != null && String(q.sample) !== '') return String(q.sample);
  const local = solveLocally(q && q.content);
  return local != null ? local : '';
}

/**
 * 本地求解（常见四则运算兜底；比大小题型返回 `>`/`<`/`=`）。
 */
function solveLocally(content) {
  const s = String(content || '').trim();
  // 比大小：`123 ? 456` / `3/4 ? 1/2` 等
  const cmp = s.match(/^(.+?)\s*([○<>]|[?？])\s*(.+)$/);
  if (cmp && cmp[2] === '?') { /* 不是比大小题 */ }
  const m = s.match(/^(-?\d+)\s*([+\-×x*÷/])\s*(-?\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    let r = null;
    switch (m[2]) {
      case '+': r = a + b; break;
      case '-': r = a - b; break;
      case '×': case 'x': case '*': r = a * b; break;
      case '÷': case '/': r = b === 0 ? null : a / b; break;
      default: break;
    }
    if (r != null) return String(r);
  }
  // 简单比大小（整数）
  const c2 = s.match(/^(-?\d+)\s*([○<>])\s*(-?\d+)$/);
  if (c2) {
    const a = Number(c2[1]);
    const b = Number(c2[3]);
    return a > b ? '>' : (a < b ? '<' : '=');
  }
  return null;
}

/** 延迟随机：min~max（都给了才随机；否则用 min）。 */
function randomDelay(minMs, maxMs) {
  const lo = Number(minMs) || 0;
  const hi = Number(maxMs) || 0;
  if (hi > lo) return lo + Math.floor(Math.random() * (hi - lo));
  return Math.max(0, lo);
}

module.exports = {
  MSG,
  WS_HOST,
  randomTraceId,
  randomTraceId19,
  traceHeader,
  buildUrl,
  buildWsUrl,
  home,
  rank,
  battleDetail,
  decodeBattleDetail,
  runOneRace,
  WsClient,
  wsHeaders,
};