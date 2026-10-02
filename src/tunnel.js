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

    const proc = spawn(av.path, ['tunnel', '--url', target, '--no-autoupdate'], {
      env: process.env,
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
  });
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