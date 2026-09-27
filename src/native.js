'use strict';
// 与小猿 arm64 原生库交互：sign 计算 + PK 提交体内容编码。
//
// 为什么不纯 JS 重写：
//  - 内容编码器 libContentEncoder.so 是加固 native 实现，直接调用可保证与真机
//    逐字节一致（已实测 IDENTICAL）；重写无收益。
//  - sign 是 4 轮 MD5，纯 JS 也能复现，但 T 段来自 so 内一个 4.6KB 的复杂函数，
//    直接调 harness（约 200ms）更稳。
//
// 关键：`LD_LIBRARY_PATH=<dir> <dir>/linker64 <ELF> [args]`
// 目录内需备齐 linker64 / libc.so / libm.so / libdl.so / liblog.so /
// libc++.so / libc++_shared.so，且 libContentEncoder.so 的
// DT_NEEDED:libandroid.so 已等长覆盖为 libc.so（_patched 文件）。
//
// 安全：spawnSync 用「可执行文件 + 参数数组」，不拼 shell 字符串。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { config } = require('./config');
const keystream = require('./keystream');

// 单次 harness 超时（毫秒）。真机实测 100~250ms，给足余量。
const NATIVE_TIMEOUT_MS = 20000;

// gzip 流的 OS 字段（第 10 字节）。真机产物该字节为 0xff。
const GZIP_OS_BYTE_INDEX = 9;
const GZIP_OS_BYTE_VALUE = 0xff;

let tmpSeq = 0;

function tmpPath(ext) {
  tmpSeq += 1;
  return path.join(os.tmpdir(), 'pk-node-' + process.pid + '-' + tmpSeq + (ext || ''));
}

// 用 proot 里的 Android linker 执行 native 可执行文件。
function runNative(bin, args) {
  const dir = config.nativeDir;
  const linker = path.join(dir, 'linker64');
  const exe = path.join(dir, bin);
  if (!fs.existsSync(linker)) throw new Error('缺少 linker64：' + linker);
  if (!fs.existsSync(exe)) throw new Error('缺少 native 组件：' + exe);

  const r = spawnSync(linker, [exe].concat(args), {
    cwd: dir,
    env: Object.assign({}, process.env, { LD_LIBRARY_PATH: dir }),
    maxBuffer: 1 << 26,
    timeout: NATIVE_TIMEOUT_MS,
  });
  return {
    status: r.status == null ? -1 : r.status,
    stdout: r.stdout ? r.stdout.toString('utf8') : '',
    stderr: r.stderr ? r.stderr.toString('utf8') : '',
  };
}

// 按设备口径 gzip：优先系统 gzip（zlib level 6、无 mtime、OS 字段 0xff）。
// 实测真机 gzip 流与本机 `gzip -6 -n` 逐字节相同，仅第 10 字节不同。
//
// 没有系统 gzip（Windows）→ 回落 Node zlib。压缩实现不同、字节会不一样，但格式合法，
// 服务端 gunzip 得回同一份 JSON —— 内容编码只是对字节流做 XOR，不要求 gzip 与真机一致。
function gzipLikeDevice(buf) {
  const r = spawnSync('gzip', ['-6', '-n', '-c'], {
    input: buf,
    maxBuffer: 1 << 26,
    timeout: NATIVE_TIMEOUT_MS,
  });
  if (r.status === 0 && r.stdout && r.stdout.length) {
    const out = Buffer.from(r.stdout);
    if (out.length > GZIP_OS_BYTE_INDEX) out[GZIP_OS_BYTE_INDEX] = GZIP_OS_BYTE_VALUE;
    return out;
  }
  const zlib = require('node:zlib');
  const gz = zlib.gzipSync(buf, { level: 6 });
  if (gz.length > GZIP_OS_BYTE_INDEX) gz[GZIP_OS_BYTE_INDEX] = GZIP_OS_BYTE_VALUE;
  return gz;
}

// 契约（逐字节验证过）：cipher = c( gzip(json, level=6, mtime=0) )，无外层 AES，等长。
//
// ★ 2026-09-27 起默认走**纯 JS**：c() 已被证明是「与固定密钥流逐位置 XOR」
//   （推导与验证见 src/keystream.js）。好处：不需要 arm64 原生库（x86/Windows 也能编码），
//   且省掉每轮 80~250ms 的子进程开销。
//   只有密钥流文件缺失时才回落到原生 libContentEncoder（等价备份路径）。
function encodeSubmitBody(jsonBytes) {
  const raw = Buffer.isBuffer(jsonBytes) ? jsonBytes : Buffer.from(String(jsonBytes), 'utf8');
  const gz = gzipLikeDevice(raw);

  // 首选：纯 JS（与原生逐字节等价，已多长度验证）
  if (keystream.available()) {
    return keystream.xorEncode(gz);
  }

  // 回落：原生编码器
  const inFile = tmpPath('.gz');
  const outFile = tmpPath('.enc');
  fs.writeFileSync(inFile, gz);
  try {
    const so = path.join(config.nativeDir, 'libContentEncoder_patched.so');
    const r = runNative('enc_device', [so, inFile, outFile]);
    if (!fs.existsSync(outFile)) {
      throw new Error('内容编码失败（无输出）：' + (r.stdout + r.stderr).slice(0, 300));
    }
    const out = fs.readFileSync(outFile);
    if (out.length !== gz.length) {
      throw new Error('内容编码长度异常：in=' + gz.length + ' out=' + out.length);
    }
    return out;
  } finally {
    safeUnlink(inFile);
    safeUnlink(outFile);
  }
}

// sign 缓存：同 path + 同分钟结果相同。key = `${minute}|${path}`
const signCache = new Map();
const SIGN_CACHE_MAX = 512;

// sign = chain(path, "wdi4n2t8edr", 0)，path 为 URL.encodedPath()（不含 query），第三参恒为 0。
function calcSign(urlPath) {
  const p = String(urlPath);
  const minute = Math.floor(Date.now() / 60000);
  const key = minute + '|' + p;
  const hit = signCache.get(key);
  if (hit) return hit;

  const so = path.join(config.nativeDir, 'lre.so');
  const r = runNative('dump7', [so, p, '0']);
  const m = /SIGN=([0-9a-f]{32})/.exec(r.stdout);
  if (!m) throw new Error('sign 计算失败：' + (r.stdout + r.stderr).slice(0, 300));

  const sign = m[1];
  if (signCache.size >= SIGN_CACHE_MAX) signCache.clear();
  signCache.set(key, sign);
  return sign;
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (e) { /* 临时文件已被清或不存在 */ }
}

// 启动自检：**编码**（纯 JS，必需）+ **sign**（仅当 signMode != off 时需要）。
// 失败则启动即报错，比跑起来才发现强。
function selfTest() {
  const enc = keystream.selfTest();
  if (!enc.ok) return { ok: false, detail: '内容编码器不可用：' + enc.detail };

  const mode = String(config.signMode || 'off').toLowerCase();
  if (mode === 'off') {
    // 默认路径：完全不需要原生库 → x86 / Windows 也能完整刷局
    return {
      ok: true,
      encoding: enc,
      signMode: 'off',
      detail: '编码（纯 JS）可用；sign 已关闭（PK 端点实测不需要）→ 无需 arm64 原生库',
    };
  }

  const need = ['linker64', 'lre.so', 'dump7'];
  const missing = need.filter((f) => !fs.existsSync(path.join(config.nativeDir, f)));
  if (missing.length) {
    const msg = '缺 sign 所需原生资产：' + missing.join(', ') +
      '（sign 需要 arm64；如不需要可设 PK_SIGN_MODE=off）';
    if (mode === 'auto') return { ok: true, encoding: enc, signMode: mode, detail: 'sign 已跳过（' + msg + '）' };
    return { ok: false, detail: msg };
  }

  try {
    const sample = calcSign('/leo-game-pk/android/math/pk/submit');
    if (!/^[0-9a-f]{32}$/.test(sample)) return { ok: false, detail: 'sign 输出异常：' + sample };
    return {
      ok: true,
      encoding: enc,
      signMode: mode,
      detail: '编码（纯 JS）+ sign（原生）均可用',
      sample: sample,
    };
  } catch (e) {
    const msg = 'sign 计算失败：' + e.message;
    if (mode === 'auto') return { ok: true, encoding: enc, signMode: mode, detail: 'sign 已跳过（' + msg + '）' };
    return { ok: false, encoding: enc, detail: msg };
  }
}

module.exports = {
  runNative,
  gzipLikeDevice,
  encodeSubmitBody,
  calcSign,
  selfTest,
};