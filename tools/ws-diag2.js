'use strict';
/**
 * ws-diag2.js —— WS 握手参数组合穷举（找 417 的解）。
 *
 * 组合维度：
 *  A) client 占位符: api / android / {client} 原样
 *  B) 公共参数+sign: 无 / 有
 *  C) 风控头: 无 / 有（x-shepherd-did 等全套）
 */
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));

const db = require('../src/db');
const jobs = require('../src/jobs');
const ss = require('../src/school-season');
const nativeLib = require('../src/native');
const { config, PK } = require('../src/config');
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

const SHEPHERD = config.shepherdDid;
console.log('shepherdDid =', SHEPHERD ? SHEPHERD.slice(0, 12) + '...' : '(空)');

function tryHandshake(opts) {
  return new Promise((resolve) => {
    const traceId = ss.randomTraceId19();
    let urlPath = '/leo-game-pk/' + opts.client + '/game/match/v2?sessionId=1520&traceId=' + traceId;
    if (opts.commonParams) {
      const q = new URLSearchParams();
      q.set('_productId', '611');
      for (const [k, v] of [['platform', PK.commonQuery.platform], ['version', PK.commonQuery.version],
        ['vendor', PK.commonQuery.vendor], ['av', PK.commonQuery.av],
        ['deviceCategory', PK.commonQuery.deviceCategory], ['webviewVersion', PK.commonQuery.webviewVersion],
        ['whRatio', PK.commonQuery.whRatio]]) q.set(k, v);
      // sign 用 encodedPath 计算
      try {
        const sign = nativeLib.calcSign('/leo-game-pk/' + opts.client + '/game/match/v2', { variant: 'pk' });
        if (sign) q.set('sign', sign);
      } catch (e) { /* ignore */ }
      urlPath += '&' + q.toString();
    }

    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      Host: 'xyks.yuanfudao.com',
      Origin: 'https://xyks.yuanfudao.com',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; DCO-AL00 Build/V417IR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 Mobile Safari/537.36 YuanSouTiKouSuan/3.143.1',
      Cookie: jar.headerFor('xyks.yuanfudao.com', '/'),
    };
    if (opts.riskHeaders) {
      const b = (s) => Buffer.from(s, 'utf8').toString('base64');
      headers['x-shepherd-did'] = SHEPHERD || 'DUtA-DmaWBaa-xgaLMMFCl5fjJG__ajuzNf3';
      headers['X-XYKS-REQ-TIMESTAMP'] = String(Date.now());
      headers['X-XYKS-REQ-NETWORK-ENV'] = 'mobile';
      headers['x-shepherd-sessionid'] = '0';
      headers['leo-client-trace-id'] = traceId;
      headers['default-namespace-sw8'] = b('1') + '-' + b(traceId) + '-' + b('0') + '-0-X19PX1JfVF9f-UF9J_UP_U9F_SV9Q';
    }

    const req = https.request({
      hostname: 'xyks.yuanfudao.com', port: 443, path: urlPath, method: 'GET',
      headers, timeout: 12000,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 200), block: res.headers['x-block-by'] || '' }));
    });
    req.on('upgrade', (res) => {
      resolve({ status: res.statusCode, upgrade: true, block: '' });
      try { res.socket.destroy(); } catch (e) { /* ignore */ }
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 'ERR', body: e.message }));
    req.end();
  });
}

(async () => {
  const combos = [];
  for (const client of ['api', 'android', '{client}']) {
    for (const commonParams of [false, true]) {
      for (const riskHeaders of [false, true]) {
        combos.push({ client, commonParams, riskHeaders });
      }
    }
  }
  for (const c of combos) {
    const r = await tryHandshake(c);
    const label = `client=${c.client} params=${c.commonParams ? 'Y' : 'N'} risk=${c.riskHeaders ? 'Y' : 'N'}`;
    console.log(label.padEnd(42), '->', r.status, r.upgrade ? 'UPGRADE!' : '', r.block ? ('block=' + r.block) : '', (r.body || '').slice(0, 80));
  }
  process.exit(0);
})();