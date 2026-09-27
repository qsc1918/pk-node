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

// 按设备口径 gzip：zlib level 6、无 mtime、OS 字段 0xff。
// 实测真机 gzip 流与本机 `gzip -6 -n` 逐字节相同，仅第 10 字节不同。
function gzipLikeDevice(buf) {
  const r = spawnSync('gzip', ['-6', '-n', '-c'], {
    input: buf,
    maxBuffer: 1 << 26,
    timeout: NATIVE_TIMEOUT_MS,
  });
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) {
    throw new Error('gzip 失败：' + (r.stderr ? r.stderr.toString() : r.status));
  }
  const out = Buffer.from(r.stdout);
  if (out.length > GZIP_OS_BYTE_INDEX) out[GZIP_OS_BYTE_INDEX] = GZIP_OS_BYTE_VALUE;
  return out;
}

// 契约（逐字节验证过）：cipher = c( gzip(json, level=6, mtime=0) )，无外层 AES，等长。
function encodeSubmitBody(jsonBytes) {
  const raw = Buffer.isBuffer(jsonBytes) ? jsonBytes : Buffer.from(String(jsonBytes), 'utf8');
  const gz = gzipLikeDevice(raw);

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

// 启动自检：native 资产齐备 + sign 可算。失败则启动即报错。
function selfTest() {
  const need = [
    'linker64', 'libc.so', 'libm.so', 'libdl.so', 'liblog.so',
    'libc++.so', 'libc++_shared.so', 'libContentEncoder_patched.so', 'lre.so', 'dump7', 'enc_device',
  ];
  for (const f of need) {
    const p = path.join(config.nativeDir, f);
    if (!fs.existsSync(p)) return { ok: false, detail: '缺少 native 资产：' + p };
  }
  try {
    const sample = calcSign('/leo-game-pk/android/math/pk/submit');
    if (!/^[0-9a-f]{32}$/.test(sample)) return { ok: false, detail: 'sign 输出异常：' + sample };
    return { ok: true, detail: 'native 链路可用', sample: sample };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

module.exports = {
  runNative,
  gzipLikeDevice,
  encodeSubmitBody,
  calcSign,
  selfTest,
};