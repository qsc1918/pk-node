'use strict';
// 内容编码器的**纯 JS 复现**（不再需要 arm64 原生库）。
//
// ## 结论怎么来的（2026-09-27 差分分析，可复现）
//
// 对 `libContentEncoder.so` 的内层函数 c() 做了四组实验：
//
// | 实验 | 结果 | 说明 |
// |---|---|---|
// | A. 翻转输入 1 bit | 输出**只变 1 个字节**，且位置相同 | 逐字节替换，无扩散 |
// | B. 两段不同的同长输入 | `in XOR out` 得到的流**完全相同** | `out[i] = in[i] ^ K[i]` |
// | C. 512B 与其所在长输入的前缀 | 密钥流**逐字节一致** | K 只与位置有关，与总长无关 |
// | D. 同输入重复编码 | 完全一致 | 确定性，无随机/时间因素 |
//
// ⇒ `c()` 就是「与一条**固定密钥流**逐位置异或」。
// 于是：**编码全零输入，输出就是密钥流本身**（`0 ^ K = K`）。
//
// ## 验证强度
//
// 用提取出的 131072 字节密钥流做纯 JS XOR，与原生 `enc_device` 对比：
// 长度 1 / 2 / 17 / 256 / 4524 / 20000 / 131071 / 131072 字节**全部逐字节一致**，
// 并且**与真机抓包密文一致**。
//
// ## 这样做的收益
//
// - 不再依赖 arm64 原生库 → x86 / Windows 也能编码（刷局只剩 sign 需要原生）
// - 省掉每轮 80~250ms 的 native 子进程开销
//
// ## 局限（如实说明）
//
// - 密钥流长度 = 131072 字节。**消息超过这个长度会直接报错**，不会静默截断
//   （真实 PK 提交体 gzip 后约 4.5KB，余量 28 倍）。
// - 密钥流来自特定版本的 `libContentEncoder.so`。若小猿更新了 so，需要重新提取：
//   `node tools/keystream-extract.js`（需 arm64 环境 + bin/native 资产）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { config } = require('./config');

/** 密钥流文件位置。 */
const KEYSTREAM_FILE = path.join(config.root, 'bin', 'keystream.bin');

/** 已知密钥流的 sha256（提取脚本会核对；不一致说明 so 换版本了）。 */
const KNOWN_SHA256 = 'b58cd2196d8a251b78c92dc155ba152f6316e41236d3ec9465f9c0695bb5fe72';

let cached = null;

/** 读入并缓存密钥流；文件缺失返回 null。 */
function load() {
  if (cached) return cached;
  try {
    const buf = fs.readFileSync(KEYSTREAM_FILE);
    cached = buf;
    return cached;
  } catch (e) {
    return null;
  }
}

/** 密钥流是否可用。 */
function available() {
  return load() != null;
}

/** 密钥流长度（不可用时为 0）。 */
function length() {
  const k = load();
  return k ? k.length : 0;
}

/**
 * 纯 JS 内容编码：`out[i] = in[i] ^ K[i]`。
 *
 * @param {Buffer} buf gzip 流
 * @returns {Buffer} 密文（与输入等长）
 */
function xorEncode(buf) {
  const K = load();
  if (!K) throw new Error('缺少密钥流文件：' + KEYSTREAM_FILE + '（可用 tools/keystream-extract.js 重新提取）');
  if (buf.length > K.length) {
    // 不静默循环复用 —— 超长就明确报错，避免发出服务端解不开的包
    throw new Error(`提交体太长（${buf.length}B > 密钥流 ${K.length}B）`);
  }
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ K[i];
  return out;
}

/** 自检：文件在、长度够、与已知 sha256 一致。 */
function selfTest() {
  const K = load();
  if (!K) return { ok: false, detail: '未找到 ' + KEYSTREAM_FILE };
  const sha = crypto.createHash('sha256').update(K).digest('hex');
  if (sha !== KNOWN_SHA256) {
    return {
      ok: true,
      warn: true,
      detail: `密钥流 sha256 与已知值不同（${sha.slice(0, 16)}…）—— so 可能换过版本，建议重新核对`,
    };
  }
  return { ok: true, detail: `密钥流可用（${K.length}B，sha256 已核对）` };
}

module.exports = {
  KEYSTREAM_FILE,
  KNOWN_SHA256,
  available,
  length,
  xorEncode,
  selfTest,
};