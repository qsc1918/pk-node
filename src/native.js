'use strict';
// 与小猿 arm64 原生库交互：sign 计算 + PK 提交体内容编码。
// 内容编码器直接调 libContentEncoder.so 保证与真机逐字节一致；sign 的 T 段来自 so 内复杂函数，调 harness 更稳。
// 关键：`LD_LIBRARY_PATH=<dir> <dir>/linker64 <ELF> [args]`，目录内需备齐 linker64/libc.so 等依赖；
// 且 libContentEncoder.so 的 DT_NEEDED:libandroid.so 已等长覆盖为 libc.so（_patched 文件）。
// 安全：spawnSync 用「可执行文件 + 参数数组」，不拼 shell 字符串。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { config } = require('./config');
const keystream = require('./keystream');
const { calcT } = require('./lre-emu');
const { chainMd5 } = require('./sign');

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

// 按设备口径 gzip：优先系统 gzip（level 6、无 mtime、OS 字段 0xff），回落 Node zlib。
// 内容编码只做 XOR，不要求 gzip 与真机逐字节一致——服务端 gunzip 得回同一份 JSON。
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
// 默认走纯 JS：c() 是与固定密钥流逐位置 XOR（见 src/keystream.js），x86/Windows 也能编码；
// 仅密钥流文件缺失时回落原生 libContentEncoder（等价备份）。
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
// T 缓存：只按分钟变化，与 path 无关 —— 同一分钟内所有 path 复用同一份 T。
const tCache = new Map();
const T_CACHE_MAX = 8;

/**
 * PK 版签名资产**单独的缓存**：两套资产算出的 T/sign 不同（服务端按 App 版本校验），
 * 缓存绝不能共用，否则会拿练习版 T 去签 PK 请求（或反过来），直接 417。
 */
const signCachePk = new Map();
const tCachePk = new Map();

/**
 * 算主域签名 `sign`（纯 JS 复刻，平台无关；正确性以 src/sign.js 真机 fixture 为准）。
 * 公式：`chainMd5(path, T)`，path 为 encodedPath（不含 query），ts 恒为 0。
 * @param {string} urlPath 只含路径
 * @param {{variant?: 'exercise'|'pk'}} [opts] 用哪套签名资产，默认 `exercise`；PK 新端点传 `'pk'`
 * @returns {string} 32 位 hex
 */
function calcSign(urlPath, opts) {
  const pk = !!(opts && opts.variant === 'pk');
  const p = String(urlPath);
  const minute = Math.floor(Date.now() / 60000);
  const key = minute + '|' + p;
  const sCache = pk ? signCachePk : signCache;
  const hit = sCache.get(key);
  if (hit) return hit;

  const tc = pk ? tCachePk : tCache;
  let T = tc.get(minute);
  if (!T) {
    T = calcT(minute * 60, pk ? 'pk' : 'exercise');
    if (tc.size >= T_CACHE_MAX) tc.clear();
    tc.set(minute, T);
  }
  const sign = chainMd5(p, T);
  if (sCache.size >= SIGN_CACHE_MAX) sCache.clear();
  sCache.set(key, sign);
  return sign;
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (e) { /* 临时文件已被清或不存在 */ }
}

/**
 * 启动自检：内容编码（纯 JS）+ sign（纯 JS 模拟 arm64）都必须可用。
 * sign 只需 `bin/native/lre.so` 机器码 + `src/lre-insns.js` 指令表，Windows/x86 也能跑通。
 */
function selfTest() {
  const enc = keystream.selfTest();
  if (!enc.ok) return { ok: false, detail: '内容编码器不可用：' + enc.detail };

  if (!fs.existsSync(path.join(config.nativeDir, 'lre.so'))) {
    return { ok: false, encoding: enc, detail: '缺少 bin/native/lre.so（T 生成所需）' };
  }

  try {
    const T = calcT(Math.floor(Date.now() / 1000));
    // T 是大数的十进制展开，位数随分钟浮动（实测 408/409/410 都可能出现），
    // 判据是「全是数字 + 位数在合理区间」，精确性由 sign.js 的 fixture 自校验保证。
    if (typeof T !== 'string' || !/^[0-9]+$/.test(T) || T.length < 380 || T.length > 460) {
      return { ok: false, encoding: enc, detail: 'T 输出异常（长度 ' + (T && T.length) + '）' };
    }
    const sample = calcSign('/leo-game-pk/android/math/pk/submit');
    if (!/^[0-9a-f]{32}$/.test(sample)) {
      return { ok: false, encoding: enc, detail: 'sign 输出异常：' + sample };
    }
    return {
      ok: true,
      encoding: enc,
      signMode: 'js',
      detail: '编码（纯 JS）+ sign（纯 JS 模拟 arm64）均可用，无需 arm64 原生资产',
      tLength: T.length,
      sample: sample,
    };
  } catch (e) {
    return { ok: false, encoding: enc, detail: 'sign 计算失败：' + e.message };
  }
}

module.exports = {
  runNative,
  gzipLikeDevice,
  encodeSubmitBody,
  calcSign,
  selfTest,
};