'use strict';
// 内容编码器的**纯 JS 复现**（不再需要 arm64 原生库）。
//
// 编码即与固定密钥流逐位置异或：`out[i] = in[i] ^ K[i]`（K 只与位置有关，确定性、无扩散）。
// 编码全零输入即得密钥流本身（`0 ^ K = K`），与原生 enc_device、真机抓包密文逐字节一致。
// 密钥流长度 = 131072 字节，消息超长直接报错（不静默截断）；so 换版本需重新提取（tools/keystream-extract.js）。

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