// 纯 JS MD5 —— Cloudflare Worker 用。
//
// 为什么自带：Worker 的 WebCrypto（crypto.subtle.digest）**不支持 MD5**
// （实测 Node 与 Workers 都报 "Unrecognized algorithm name"），
// 而主域 sign 链条正是 4 轮 MD5。
//
// 正确性：已与 Node 的 crypto.createHash('md5') 逐字节对照通过
// （含空串 / 长串 / 二进制 / 完整 sign 链条，见 tools/test-md5.mjs）。
//
// ## 形态：ESM
//
// 本目录（deploy/）整体是 **ESM** —— 见 deploy/package.json 的 `"type": "module"`。
// 原因：CI 会对仓库里**所有** .js 跑 `node --check`，而根 package.json 是
// CommonJS；本文件以前用 CommonJS 的导出形式，在 `"type":"module"` 的目录下
// 会报 `module is not defined`。这里改用 ESM 导出，与同目录其它文件一致。
// （`tools/gen-worker-bundle.js` 只把它当**文本**读、再转写成 Worker 版，
//   不加载它，所以改导出形式对打包无影响。）
//
// ⚠️ 本文里不要出现 「CommonJS 导出语句」的字面写法（生成器自检会误判为残留）。

export function md5(input) {
  let bytes;
  if (typeof input === 'string') bytes = new TextEncoder().encode(input);
  else if (input instanceof Uint8Array) bytes = input;
  else bytes = new Uint8Array(input);

  const len = bytes.length;
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const M = new Uint32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      const s = S[i];
      B = (B + (((F << s) | (F >>> (32 - s))) >>> 0)) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true); odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
  return out;
}

export function md5hex(input) {
  return Array.from(md5(input)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

export default { md5, md5hex };
