#!/usr/bin/env node
'use strict';
/**
 * 统一的启动器 —— start.sh 与 start.bat 都只负责调它。
 * 校验 Node 版本 / 挑空闲端口 / 打印横幅都放在这里（一份代码跨平台共用），
 * 让 bat 保持纯 ASCII + CRLF，避免 cmd.exe 解析失败。零依赖。
 */

const net = require('node:net');
const path = require('node:path');
// 与 server.js 共用同一份「默认监听地址」定义，避免两边漂移
// （这里以前也硬编码了 127.0.0.1，会把暴露到局域网的路堵死）。
const { DEFAULT_HOST, lanAddresses } = require('../src/config');

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

const HOST = process.env.PK_HOST || DEFAULT_HOST;
const WANT = Number(process.env.PK_PORT || 8792);
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

/** 从 start 起找一个空闲端口；找不到返回 null。探针地址直接用 HOST。 */
async function pickPort(start) {
  for (let p = start; p < start + SPAN; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await tryPort(p, HOST)) return p;
  }
  return null;
}

/* ------------------------------ 3) 启动 ------------------------------ */

(async () => {
  const port = await pickPort(DEFAULT_PORT);
  if (!port) {
    fail(DEFAULT_PORT + '~' + (DEFAULT_PORT + SPAN - 1) + ' 都被占用了，请指定一个空闲端口：' +
      (process.platform === 'win32' ? 'set PK_PORT=9000 & start.bat' : 'PK_PORT=9000 ./start.sh'));
  }
  if (port !== DEFAULT_PORT) console.log('提示：' + DEFAULT_PORT + ' 已被占用，自动改用 ' + port);

  // 必须在 require server.js 之前写回环境变量 —— config.js 在 require 时读 process.env.PK_PORT。
  process.env.PK_PORT = String(port);

  console.log('== pk-node ==');
  console.log('node      : v' + process.versions.node);
  console.log('监听      : http://' + HOST + ':' + port);
  console.log('native 目录: ' + path.join(ROOT, 'bin', 'native'));
  // 直接把局域网地址打出来（照着点就能开），省得用户自己敲 ipconfig
  const lan = lanAddresses();
  if (lan.length) {
    console.log('局域网访问: ' + (lan.length > 1 ? '（任选一个）' : '') +
      lan.map((ip) => 'http://' + ip + ':' + port).join('  '));
  }
  if (HOST === DEFAULT_HOST) {
    console.log('提示      : 已监听所有网卡（局域网/公网可访问）。公网需路由器做端口映射；' +
      '打不开多半是 Windows 防火墙拦了入站。');
  } else if (HOST !== '127.0.0.1') {
    console.log('提示      : 只监听 ' + HOST + '；本机用 http://127.0.0.1:' + port);
  }
  console.log('');

  const app = require(path.join(ROOT, 'server.js'));
  app.main();
})().catch((e) => fail(e && e.message ? e.message : String(e)));
