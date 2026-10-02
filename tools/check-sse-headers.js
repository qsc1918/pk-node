#!/usr/bin/env node
'use strict';
/**
 * 校验**两个 SSE（实时日志）端点**的响应头与首包行为。
 *
 * ## 为什么需要它（2026-10-02 的教训）
 *
 * 用户报「通过隧道地址访问看不到日志」。SSE 是长连接，中间层（Cloudflare /
 * nginx）对它的处理与普通请求完全不同，而**出错时是静默的**：
 *  - 缺 `no-transform` → 边缘压缩 SSE → 前端 EventSource 一直空白；
 *  - 缺 `Content-Encoding: identity` → 同上（gzip 会整段缓冲）；
 *  - `res.writeHead()` 之后再 `res.setHeader()` → 抛 ERR_HTTP_HEADERS_SENT
 *    → 连接被掐断、**连快照都收不到**（这个我自己写错过一次）；
 *  - `write()` 收到对象却直接字符串拼接 → `data: [object Object]`（也写错过一次）。
 *
 * 这四种问题本地直连**都不会暴露**（本地没有边缘压缩；症状只是「没日志」），
 * 所以必须有一个把「响应头 + 首包内容」当门禁的脚本。
 *
 * ## 用法
 *
 *   node tools/check-sse-headers.js            # 自己起一个隔离实例（推荐）
 *   node tools/check-sse-headers.js 8792       # 用已经在跑的实例（需 admin/admin）
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || 0) || 18899;
const USE_EXISTING = !!process.argv[2];

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读取一个 SSE 端点：返回 { status, headers, firstChunks }，读完首包就主动断开。 */
async function probeStream(url, cookie) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers: cookie ? { Cookie: cookie } : {}, signal: ctrl.signal });
  const headers = {};
  for (const [k, v] of res.headers) headers[k.toLowerCase()] = v;

  let body = '';
  if (res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const race = await Promise.race([
        reader.read(),
        sleep(1500).then(() => ({ timeout: true })),
      ]);
      if (race.timeout) break;
      if (race.done) break;
      body += dec.decode(race.value, { stream: true });
      if (body.length > 400) break;
    }
    try { ctrl.abort(); } catch (e) { /* ignore */ }
  }
  return { status: res.status, headers, body };
}

async function cookiesFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return raw.map((c) => c.split(';')[0]).join('; ');
}

async function main() {
  let child = null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-sse-'));
  const dbPath = path.join(tmp, 'pk.sqlite');
  // ★★ 必须让**本脚本自己**也用同一个隔离库：
  //   config.js 在 require 时读 env，所以要在 require('src/db.js') 之前设好。
  //   否则脚本会把「验证用 job」写进**真实** data/pk-node.sqlite（踩过一次）。
  process.env.PK_DB = dbPath;
  if (!USE_EXISTING) {
    console.log('== 起隔离实例（PK_DB=' + dbPath + ', 端口 ' + PORT + '）==');
    child = spawn(process.execPath, ['bin/start.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PK_DB: dbPath,
        PK_PORT: String(PORT),
        PK_HOST: '127.0.0.1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });
    for (let i = 0; i < 30; i++) {
      if (/已监听/.test(log)) break;
      await sleep(500);
    }
    if (!/已监听/.test(log)) {
      console.error('服务未起来：\n' + log);
      process.exit(2);
    }
  }

  const BASE = 'http://127.0.0.1:' + PORT;

  // 登录
  const lr = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const cookie = await cookiesFrom(lr);
  check('登录 200 且拿到会话 cookie', lr.status === 200 && !!cookie, 'status=' + lr.status);

  // 造一条 job（直接用 db 模块写隔离库）
  const db = require(path.join(ROOT, 'src', 'db.js'));
  db.init();
  const uid = db.listUsers()[0].id;
  const leoId = db.addLeoAccount(uid, 'sse-check', [], {});
  const jobId = db.createJob(uid, leoId, null, { kind: 'pk' }, 1);
  db.setJobStatus(jobId, 'running', { startedAt: Date.now() });
  db.addJobRound(jobId, 1, true, 200, 'sse-check 轮次', 'detail');

  console.log('\n== 任务日志流 /api/jobs/' + jobId + '/stream ==');
  const a = await probeStream(BASE + '/api/jobs/' + jobId + '/stream', cookie);
  console.log('  status=' + a.status + ' ct=' + a.headers['content-type']);
  console.log('  cache-control=' + a.headers['cache-control']);
  console.log('  content-encoding=' + (a.headers['content-encoding'] || '(未声明)'));
  check('HTTP 200', a.status === 200, 'status=' + a.status);
  check('Content-Type: text/event-stream', /text\/event-stream/.test(a.headers['content-type'] || ''));
  check('Cache-Control 含 no-transform（边缘不许压缩）',
    /no-transform/.test(a.headers['cache-control'] || ''), a.headers['cache-control']);
  check('Content-Encoding: identity（SSE 不被 gzip）',
    (a.headers['content-encoding'] || '') === 'identity', a.headers['content-encoding']);
  check('Connection: keep-alive', /keep-alive/.test(a.headers['connection'] || ''), a.headers['connection']);
  check('X-Accel-Buffering: no', (a.headers['x-accel-buffering'] || '') === 'no');
  check('首包立即可读（未被缓冲）', /(: ok|retry:|data:)/.test(a.body), JSON.stringify(a.body.slice(0, 60)));
  check('snapshot 快照已序列化为 JSON（不是 [object Object]）',
    /data: \{"type":"snapshot"/.test(a.body), JSON.stringify(a.body.slice(0, 120)));
  check('未出现 [object Object]', !/\[object Object\]/.test(a.body));
  check('retry 字段原样发出（不是 data: retry）', /(^|\n)retry: \d+/.test(a.body) || !/retry/.test(a.body));

  console.log('\n== 练习日志流 /api/exercise/stream ==');
  const b = await probeStream(BASE + '/api/exercise/stream', cookie);
  console.log('  status=' + b.status + ' cache-control=' + b.headers['cache-control']);
  check('HTTP 200', b.status === 200, 'status=' + b.status);
  check('Cache-Control 含 no-transform', /no-transform/.test(b.headers['cache-control'] || ''));
  check('Content-Encoding: identity', (b.headers['content-encoding'] || '') === 'identity');

  console.log('\n== 未登录访问应 401（隧道下会话失效时的表现）==');
  const c = await probeStream(BASE + '/api/jobs/' + jobId + '/stream', '');
  check('无 cookie → 401', c.status === 401, 'status=' + c.status);

  if (child) { try { child.kill('SIGTERM'); } catch (e) { /* ignore */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n结果：pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('检查脚本异常：', e); process.exit(2); });
