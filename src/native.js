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
// T 缓存：只按分钟变化，与 path 无关 —— 同一分钟内所有 path 复用同一份 T。
const tCache = new Map();
const T_CACHE_MAX = 8;

/**
 * 算主域签名 `sign`。
 *
 * ## ★ 2026-10-01：改为纯 JS 复刻，不再依赖 arm64（这是练习链路 417 的根治）
 *
 * 原实现用 `bin/native/linker64 + dump7` 执行 `lre.so` 里那段混淆代码来取 T ——
 * 那是 **arm64 ELF，Windows / x86 上根本跑不起来**，`calcSign` 一失败，
 * `exercise.maybeSign()` 就静默不带 `sign`，练习端点必然 **417
 * `x-block-by: solar-encoder`**（PK 端点不需要 sign，所以只有练习挂）。
 *
 * 现在 T 由 [calcT] 在 JS 里执行同一段机器码算出（见 `src/lre-emu.js`），
 * 平台无关。正确性以 `src/sign.js` 的真机 fixture 为准：模拟输出与抓包 T
 * **逐字节一致（410/410）**。
 *
 * `sign` 公式仍是 `chainMd5(path, T)`：path 为 `url.encodedPath()`（不含 query），
 * 第三参 ts 恒为 0。
 */
function calcSign(urlPath) {
  const p = String(urlPath);
  const minute = Math.floor(Date.now() / 60000);
  const key = minute + '|' + p;
  const hit = signCache.get(key);
  if (hit) return hit;

  let T = tCache.get(minute);
  if (!T) {
    T = calcT(minute * 60);
    if (tCache.size >= T_CACHE_MAX) tCache.clear();
    tCache.set(minute, T);
  }
  const sign = chainMd5(p, T);
  if (signCache.size >= SIGN_CACHE_MAX) signCache.clear();
  signCache.set(key, sign);
  return sign;
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (e) { /* 临时文件已被清或不存在 */ }
}

/**
 * 启动自检：**内容编码**（纯 JS）+ **sign**（纯 JS 模拟 arm64）都必须可用。
 *
 * ★ 2026-10-01：sign 不再依赖 arm64 原生资产（linker64 / dump7），只需
 * `bin/native/lre.so` 提供机器码 + `src/lre-insns.js` 指令表 —— 所以
 * **Windows / x86 上练习链路也能完整跑通**（此前这里是 417 的根因）。
 */
function selfTest() {
  const enc = keystream.selfTest();
  if (!enc.ok) return { ok: false, detail: '内容编码器不可用：' + enc.detail };

  if (!fs.existsSync(path.join(config.nativeDir, 'lre.so'))) {
    return { ok: false, encoding: enc, detail: '缺少 bin/native/lre.so（T 生成所需）' };
  }

  try {
    const T = calcT(Math.floor(Date.now() / 1000));
    if (typeof T !== 'string' || T.length !== 410 || !/^[0-9]+$/.test(T)) {
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