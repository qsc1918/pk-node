'use strict';
// 从 libContentEncoder.so 提取内容编码器的密钥流（bin/keystream.bin）。
//
// ## 原理
//
// 差分分析证明 `c()` 就是「与固定密钥流逐位置 XOR」：
//   - 翻转输入 1 bit → 输出只变 1 个字节（同位置）
//   - 两段不同的同长输入，`in XOR out` 得到的流完全相同
//   - 短输入的密钥流 = 长输入密钥流的前缀
//   - 同输入重复编码结果一致（确定性）
//
// ⇒ `out[i] = in[i] ^ K[i]`，于是**编码全零输入，输出就是 K**（`0 ^ K = K`）。
//
// ## 什么时候需要跑
//
// 只有当小猿更新了 App、`libContentEncoder.so` 换了版本时才需要重新提取。
// 提取后请核对输出的 sha256，并同步更新 src/keystream.js 里的 `KNOWN_SHA256`。
//
// ## 前提
//
// arm64 环境 + `bin/native/` 资产（linker64 / enc_device / libContentEncoder_patched.so）。
// x86 上跑不了 —— 那些是 arm64 库。
//
// 用法：
//   node tools/keystream-extract.js                 # 默认 128 KiB
//   node tools/keystream-extract.js 262144          # 自定义长度
//   node tools/keystream-extract.js 131072 out.bin  # 自定义输出

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'bin', 'native');
const SO = path.join(NATIVE, 'libContentEncoder_patched.so');
const TMP = os.tmpdir();

const LEN = Number(process.argv[2] || 131072);
const OUT = process.argv[3] || path.join(ROOT, 'bin', 'keystream.bin');

let seq = 0;

/** 用原生 harness 编码一段字节。 */
function nativeEncode(buf) {
  seq += 1;
  const inF = path.join(TMP, `ks-in-${seq}.bin`);
  const outF = path.join(TMP, `ks-out-${seq}.bin`);
  fs.writeFileSync(inF, buf);
  const r = spawnSync(path.join(NATIVE, 'linker64'),
    [path.join(NATIVE, 'enc_device'), SO, inF, outF],
    { env: Object.assign({}, process.env, { LD_LIBRARY_PATH: NATIVE }), cwd: NATIVE, maxBuffer: 1 << 28 });
  if (!fs.existsSync(outF)) {
    throw new Error('原生编码失败（是否 arm64？bin/native 是否齐全？）：' +
      (r.stdout + r.stderr).toString().slice(0, 300));
  }
  const out = fs.readFileSync(outF);
  fs.unlinkSync(inF);
  fs.unlinkSync(outF);
  return out;
}

/** 纯 JS 编码：out[i] = in[i] ^ K[i] */
function jsEncode(buf, K) {
  const o = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) o[i] = buf[i] ^ K[i];
  return o;
}

function main() {
  console.log('== 提取内容编码器密钥流 ==');
  console.log('native :', NATIVE);
  console.log('长度   :', LEN);

  const K = nativeEncode(Buffer.alloc(LEN));      // 全零输入 → 输出即密钥流
  console.log('已提取 :', K.length, '字节');

  console.log('\n== 验证：纯 JS XOR 是否与原生一致 ==');
  const sizes = [1, 2, 17, 256, 4524, 20000, LEN - 1, LEN].filter((n) => n >= 1 && n <= LEN);
  let ok = true;
  for (const n of sizes) {
    const input = Buffer.alloc(n);
    for (let i = 0; i < n; i++) input[i] = (i * 2654435761 + 12345) & 0xff;
    const same = nativeEncode(input).equals(jsEncode(input, K));
    if (!same) ok = false;
    console.log(`  ${String(n).padStart(7)}B → ${same ? '一致' : '不一致 ✗'}`);
  }

  // 若本机有真机样本，顺带对一次
  const sample = process.env.PK_SAMPLE_PLAIN || '/root/alinker/pk_body.json';
  const encB64 = process.env.PK_SAMPLE_ENC || '/sdcard/pk_body.enc.b64';
  if (fs.existsSync(sample) && fs.existsSync(encB64)) {
    const gz = Buffer.from(spawnSync('gzip', ['-6', '-n', '-c'],
      { input: fs.readFileSync(sample), maxBuffer: 1 << 26 }).stdout);
    gz[9] = 0xff;                                 // 对齐真机 gzip 的 OS 字节
    const real = Buffer.from(fs.readFileSync(encB64, 'utf8').trim(), 'base64');
    const same = jsEncode(gz, K).equals(real);
    if (!same) ok = false;
    console.log(`  真机样本 → ${same ? '与真机密文一致' : '不一致 ✗'}`);
  } else {
    console.log('  （无真机样本，跳过）');
  }

  if (!ok) {
    console.error('\n✗ 验证未通过，未写出密钥流');
    process.exit(1);
  }

  fs.writeFileSync(OUT, K);
  const sha = crypto.createHash('sha256').update(K).digest('hex');
  console.log('\n★ 全部通过');
  console.log('写出   :', OUT, `(${K.length} 字节)`);
  console.log('sha256 :', sha);
  console.log('\n请把上面的 sha256 同步到 src/keystream.js 的 KNOWN_SHA256。');
}

main();