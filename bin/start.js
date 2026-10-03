#!/usr/bin/env node
'use strict';
/**
 * 统一的启动器 —— start.sh 与 start.bat 都只负责调它。
 * 校验 Node 版本 / 挑空闲端口 / 打印横幅都放在这里（一份代码跨平台共用），
 * 让 bat 保持纯 ASCII + CRLF，避免 cmd.exe 解析失败。零依赖。
 */

const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error('[x] ' + msg);
  process.exit(1);
}

/* ------------------------------ 1) Node 版本 ------------------------------ */

const major = Number(String(process.versions.node).split('.')[0]);
if (!(major >= 22)) {
  fail('Node 版本过低（当前 v' + process.versions.node + '），需要 >= 22（用到内置 node:sqlite）');
}

/* ------------------------------ 2) 端口选择 ------------------------------ */
//
// ⚠️ 不能靠 `ss` / `netstat` 判断占用（本机在 proot 里看不到宿主侧的监听），
// 唯一可靠的办法是**真的 listen 一次**。

// ⚠️ 托管平台（alwaysdata / Render / Railway 等）会注入 `HOST` + `PORT`，此时
//    必须**原样监听**，绝不能另挑端口 —— 平台的转发只打到它指定的那个端口。
//    本地运行时走原来的「自动避让占用端口」逻辑。
const ENV_PORT = Number(process.env.PORT);
const FORCED_PORT = Number.isFinite(ENV_PORT) && ENV_PORT > 0 ? ENV_PORT : null;
const HOST = process.env.PK_HOST || process.env.HOST || '127.0.0.1';
const WANT = Number(process.env.PK_PORT || FORCED_PORT || 8792);
const DEFAULT_PORT = Number.isFinite(WANT) && WANT > 0 ? WANT : 8792;
const SPAN = 40;

/** 尝试在 host:port 上监听；成功立刻关闭并返回 true。 */
function tryPort(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try {
      srv.listen(port, host);
    } catch (e) {
      resolve(false);
    }
  });
}

/** 从 start 起找一个空闲端口；找不到返回 null。 */
async function pickPort(start) {
  const host = HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  for (let p = start; p < start + SPAN; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await tryPort(p, host)) return p;
  }
  return null;
}

/* ------------------------------ 3) 启动 ------------------------------ */

(async () => {
  // 平台指定了端口就直接用（挑别的端口平台转发不过来）；否则本地自动避让。
  const port = FORCED_PORT || (await pickPort(DEFAULT_PORT));
  if (!port) {
    fail(DEFAULT_PORT + '~' + (DEFAULT_PORT + SPAN - 1) + ' 都被占用了，请指定一个空闲端口：' +
      (process.platform === 'win32' ? 'set PK_PORT=9000 & start.bat' : 'PK_PORT=9000 ./start.sh'));
  }
  if (port !== DEFAULT_PORT) console.log('提示：' + DEFAULT_PORT + ' 已被占用，自动改用 ' + port);

  // 必须在 require server.js 之前写回环境变量 —— config.js 在 require 时读 process.env。
  process.env.PK_PORT = String(port);
  process.env.PK_HOST = HOST;

  console.log('== pk-node ==');
  console.log('node      : v' + process.versions.node);
  console.log('监听      : http://' + HOST + ':' + port);
  console.log('native 目录: ' + path.join(ROOT, 'bin', 'native'));
  console.log('');

  const app = require(path.join(ROOT, 'server.js'));
  app.main();
})().catch((e) => fail(e && e.message ? e.message : String(e)));
