'use strict';
// Cloudflare 快速隧道（trycloudflare.com）封装。
// 用 cloudflared 的 Quick Tunnel（无需账号），启动后从 stderr 解析出公网地址。
// 限制：临时（进程停即失效）、无鉴权（拿到地址即可访问，故本服务强制登录）、境内速度一般。

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { config } = require('./config');

/** 公网地址匹配：trycloudflare 二级域（cloudflared 输出格式可能有变化，多留几种）。 */
const URL_RE = /(https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com)/i;

/** 当前隧道状态。 */
const state = {
  proc: null,
  url: null,
  startedAt: null,
  /** 最近若干行 cloudflared 输出，供网页展示（排查用）。 */
  logs: [],
  lastError: null,
};

function pushLog(line) {
  state.logs.push(line);
  if (state.logs.length > 200) state.logs.shift();
}

/** 检测 cloudflared 可执行文件是否就绪。 */
function available() {
  if (fs.existsSync(config.cloudflaredPath)) return { ok: true, path: config.cloudflaredPath };
  // 也接受 PATH 里的 cloudflared
  const which = require('node:child_process').spawnSync('sh', ['-c', 'command -v cloudflared'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return { ok: true, path: which.stdout.trim() };
  return {
    ok: false,
    path: config.cloudflaredPath,
    message:
      '未找到 cloudflared。请先下载：\n' +
      '  mkdir -p ' + path.dirname(config.cloudflaredPath) + '\n' +
      '  curl -L -o ' + config.cloudflaredPath + ' \\\n' +
      '    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64\n' +
      '  chmod +x ' + config.cloudflaredPath,
  };
}

/** 当前状态（可安全返回给网页，不含敏感信息）。 */
function status() {
  return {
    running: !!(state.proc && state.proc.exitCode == null),
    url: state.url,
    startedAt: state.startedAt,
    logs: state.logs.slice(-40),
    lastError: state.lastError,
    available: available().ok,
  };
}

/**
 * 启动快速隧道。
 *
 * @param {number} [port] 目标本地端口，默认 config.port
 * @returns {Promise<{ok:boolean, url?:string, message?:string}>} 解析出公网地址才 resolve
 */
function start(port) {
  const av = available();
  if (!av.ok) return Promise.resolve({ ok: false, message: av.message });
  if (state.proc && state.proc.exitCode == null) {
    return Promise.resolve({ ok: true, url: state.url, message: '隧道已在运行' });
  }

  const target = 'http://127.0.0.1:' + (port || config.port);
  state.url = null;
  state.lastError = null;
  state.startedAt = Date.now();
  state.logs = [];

  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    // ★★★ 2026-10-05 定案：DNS 问题**已在二进制层面解决**，这里无需任何 hack。
    //
    // ## 历史（三条死路，别再走）
    //
    // cloudflared 官方 `linux-arm64` 是 **GOOS=linux 纯静态**构建，DNS 用 Go 自己的
    // resolver，**只读 `/etc/resolv.conf`** —— 而 Android 没有这个文件（`/` 是 erofs
    // 只读、`/etc` 是只读软链，**连 root 都 remount 不了**）。它于是退化到查本机 `:53`：
    //   `lookup api.trycloudflare.com on [::1]:53: connection refused`
    //
    // 为此走过的三条死路（**全部实测失败**）：
    //   ① 写 `/etc/resolv.conf` —— 只读分区，写不进去；
    //   ② `--dns-resolver-addrs` / `TUNNEL_DNS_RESOLVER_ADDRS` —— 只作用于
    //      `tunnel run`（命名隧道），**对 quick tunnel 无效**（实测仍报原错误）；
    //   ③ `HTTPS_PROXY` + 自建 CONNECT 代理 —— cloudflared **不遵循任何代理环境变量**
    //      （给它一个必然连不上的坏代理，它照样成功 ⇒ 那条代码路径根本没走）。
    //
    // ## 正解（已落地在 `bin/get-cloudflared.sh`）
    //
    // 换成 **Termux 的 `GOOS=android` 构建**：它的 DNS 走 bionic 的 `getaddrinfo`
    // → netd 的 `dnsproxyd` socket（`/dev/socket/dnsproxyd` 属 `inet` 组，
    // **所有 App 都在这个组里**）⇒ **不需要 root、不需要改系统文件、任何设备都能用**。
    // 这正是「Termux 里不 root 也能用」的原因。
    //
    // 所以这里只管启动，DNS 交给二进制自己（它知道怎么问 Android）。
    const args = [
      'tunnel', '--url', target, '--no-autoupdate',
      // 避免优先走 IPv6（部分网络下 IPv6 到 Cloudflare 边缘不稳）。
      '--edge-ip-version', '4',
      // QUIC 默认 `auto` 可能选 UDP；http2 走 TCP 更可靠。
      '--protocol', 'http2',
    ];
    // 环境变量：把代理相关全清掉（避免上层环境里残留的代理影响直连）。
    const env = { ...process.env };
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
      delete env[k];
    }
    spawnTunnel(av, args, env, done);
  });
}



/**
 * 启动 cloudflared 进程并解析输出。
 *
 * 抽出来是为了让 start() 的流程更清晰（参数/环境准备 vs 进程与输出）。
 */
function spawnTunnel(av, args, env, done) {
    const proc = spawn(av.path, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.proc = proc;

    const onChunk = (buf) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        pushLog(line.trim());
        const m = URL_RE.exec(line);
        if (m && !state.url) {
          state.url = m[1];
          done({ ok: true, url: state.url });
      }
    }
    };
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);

    proc.on('error', (e) => {
      state.lastError = '启动 cloudflared 失败：' + e.message;
      done({ ok: false, message: state.lastError });
    });

    proc.on('exit', (code) => {
      pushLog('cloudflared 退出，code=' + code);
      state.lastError = 'cloudflared 退出（code=' + code + '）';
      state.url = null;
      state.proc = null;
      done({ ok: false, message: state.lastError });
    });

    // 20 秒内没解析出地址就算失败（但进程仍可能在跑，这里只影响返回值）
    setTimeout(() => {
      done({ ok: !!state.url, url: state.url, message: state.url ? undefined : '等待公网地址超时（20s），请看日志' });
    }, 20000);
}

/** 停止隧道。 */
function stop() {
  if (state.proc && state.proc.exitCode == null) {
    state.proc.kill('SIGTERM');
  }
  state.proc = null;
  state.url = null;
  state.startedAt = null;
  return { ok: true };
}

module.exports = { available, status, start, stop };

// ★ 2026-10-05：本文件曾尝试过三种 DNS 绕过方案（写 resolv.conf / HTTPS_PROXY 代理 /
// `--dns-resolver-addrs`），**全部实测失败**（原因见 start() 里的完整记录）。
//
// 最终方案在**二进制层面**：把 cloudflared 换成 Termux 的 `GOOS=android` 构建
// （DNS 走 bionic → netd，App 天生可用）。下载/换装脚本：`bin/get-cloudflared.sh`。
// 所以 `src/tunnel.js` 现在很干净 —— 只管启动，不碰 DNS。
