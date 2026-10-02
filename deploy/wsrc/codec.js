// 内容编码 / 解码（Worker 版）。
//
// 两条链路（与本机 pk-node 的 src/native.js + src/keystream.js 一致）：
//
//   编码（提交）：json → gzip(level 6) → 与固定密钥流逐字节 XOR → octet-stream
//   解码（响应）：密文 → XOR 密钥流 → gunzip → json
//
// 为什么用 gzip 而不是纯 JS 压缩：内容编码只是「对字节流做 XOR」，
// 服务端会 gunzip 回来 —— 所以**不要求与真机逐字节相同**，用平台的 gzip 即可。

import { KEYSTREAM } from './ks.js';

let ksBytes = null;
function keystream() {
  if (!ksBytes) {
    const bin = atob(KEYSTREAM);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    ksBytes = out;
  }
  return ksBytes;
}

/** 与密钥流逐位置 XOR（编码/解码是同一个操作）。 */
function xorWithKeystream(bytes) {
  const K = keystream();
  if (bytes.length > K.length) {
    throw new Error('提交体太长（' + bytes.length + 'B > 密钥流 ' + K.length + 'B）');
  }
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ K[i];
  return out;
}

async function gzip(bytes) {
  const cs = new CompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 编码提交体：对象 → 密文（octet-stream 用）。
 * @param {object} obj 提交体
 * @returns {Promise<Uint8Array>}
 */
export async function encodeBody(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  const gz = await gzip(raw);
  return xorWithKeystream(gz);
}

/**
 * 解码加密响应：密文 → 明文 JSON 对象（失败返回 null）。
 * 与 pk-h5-proxy 的 decodeEncrypted 同一套逻辑。
 */
export async function decodeBody(buf) {
  try {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (!bytes.length) return null;

    // ★ 0) 明文 JSON 直接返回。
    //   ⚠️ 踩坑：`history/detail` 这类接口返回的是**普通 JSON**，不走 XOR 加密；
    //   如果先 XOR 再判断，明文会被异或成乱码 → 解析失败（线上曾出现 settled=null）。
    //   判据：首字节是 `{` 或 `[`（JSON 开头）或 `<`（HTML，直接算失败）。
    if (bytes[0] === 0x7b || bytes[0] === 0x5b) {
      return JSON.parse(new TextDecoder().decode(bytes));
    }

    // 1) 已经是 gzip 明文（未加密）
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return JSON.parse(new TextDecoder().decode(await gunzip(bytes)));
    }

    // 2) 加密响应：XOR 密钥流 → gunzip → JSON
    const gz = xorWithKeystream(bytes);
    if (!(gz[0] === 0x1f && gz[1] === 0x8b)) {
      const asText = new TextDecoder().decode(gz);
      if (asText.trim().startsWith('{') || asText.trim().startsWith('[')) return JSON.parse(asText);
      return null;
    }
    return JSON.parse(new TextDecoder().decode(await gunzip(gz)));
  } catch (e) {
    return null;
  }
}