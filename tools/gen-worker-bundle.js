'use strict';
/**
 * 生成「可直接部署到 Cloudflare Workers（免费层）」的签名计算包。
 *
 * ## 为什么需要它
 *
 * 云端没有容器（Containers 要 $5/月），只能把 pk-node 的核心能力移植到 Worker。
 * 最难的一块是**主域签名**：它依赖两套「按时分钟生成 T」的 arm64 原生库
 * （练习版 lre.so / PK 版 lre_pk.so），以及 4 轮 MD5。
 *
 * 本脚本把这三样改造成 Worker 可静态 import 的 ESM 模块：
 *
 * | 产物 | 来源 | 说明 |
 * |---|---|---|
 * | `so-ex.js` / `so-pk.js` | `bin/native/lre*.so` | base64 内联（Worker 无文件系统）|
 * | `insns-ex.js` / `insns-pk.js` | `src/lre-insns*.js` | 指令表（CommonJS → ESM）|
 * | `emu.js` | `src/lre-emu.js` | arm64 模拟器；去掉 node:fs，改静态 import |
 * | `md5.js` | `deploy/md5.src.js` | 纯 JS MD5（Worker 的 WebCrypto 不支持 MD5）|
 * | `sign.js` | 本脚本生成 | sign 链条（4 轮 MD5）|
 *
 * 用法：`node tools/gen-worker-bundle.js`
 * 产物目录：`deploy/w/`（整体作为 Worker 的 src 部署）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'deploy', 'w');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const written = [];
const w = (name, content) => {
  fs.writeFileSync(path.join(OUT, name), content);
  written.push({ name, size: Buffer.byteLength(content, 'utf8') });
};

// ---------- 1) so → base64 模块（Worker 无 fs，只能内联） ----------
for (const [file, ident] of [['lre.so', 'EX'], ['lre_pk.so', 'PK']]) {
  const bytes = fs.readFileSync(path.join(ROOT, 'bin', 'native', file));
  w(
    'so-' + ident.toLowerCase() + '.js',
    '// 自动生成：' + file + '（' + bytes.length + ' 字节）—— 供 Worker 静态 import。\n'
    + '// 用途：计算主域签名的 T（' + (ident === 'PK' ? 'PK 端点' : '练习端点') + '）。\n'
    + 'export const ' + ident + ' = "' + bytes.toString('base64') + '";\n',
  );
}

// ---------- 2) 指令表 → ESM ----------
for (const [src, dst] of [['lre-insns.js', 'insns-ex.js'], ['lre-insns-pk.js', 'insns-pk.js']]) {
  let s = fs.readFileSync(path.join(ROOT, 'src', src), 'utf8');
  s = s.replace(/module\.exports\s*=\s*/, 'export default ');
  if (!/export default/.test(s)) s += '\nexport default {};\n';
  w(dst, s);
}

// ---------- 3) lre-emu → ESM ----------
let emu = fs.readFileSync(path.join(ROOT, 'src', 'lre-emu.js'), 'utf8');

let header = [
  '// 自动生成（改造自 src/lre-emu.js）—— 供 Cloudflare Worker 静态 import。',
  '// 改动：去掉 node:fs/node:path，so 字节与指令表改为静态 import；Buffer → Uint8Array。',
  "import { EX as __SO_EX_B64 } from './so-ex.js';",
  "import { PK as __SO_PK_B64 } from './so-pk.js';",
  "import __INSNS_EX_MOD from './insns-ex.js';",
  "import __INSNS_PK_MOD from './insns-pk.js';",
  '',
  '// Buffer 的最小 polyfill：Workers 没有 node:Buffer，但模拟器用到它的若干实例方法',
  '// （readUInt32LE / readBigUInt64LE / writeUInt32LE / writeBigUInt64LE）。',
  'class __Buf extends Uint8Array {',
  '  __dv() { return new DataView(this.buffer, this.byteOffset, this.byteLength); }',
  '  readUInt32LE(o) { return this.__dv().getUint32(o, true); }',
  '  readBigUInt64LE(o) { return this.__dv().getBigUint64(o, true); }',
  '  writeUInt32LE(v, o) { this.__dv().setUint32(o, v >>> 0, true); return o + 4; }',
  '  writeBigUInt64LE(v, o) { this.__dv().setBigUint64(o, BigInt(v) & MASK64, true); return o + 8; }',
  '}',
  'function __bufAlloc(n) { return new __Buf(n); }',
  'function __bufFrom(x) { return x instanceof __Buf ? x : new __Buf(x); }',
  'const __soCache = {};',
  'function __b64ToBytes(b64) {',
  '  const bin = atob(b64);',
  '  const out = new __Buf(bin.length);',
  '  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);',
  '  return out;',
  '}',
  '',
].join('\n');
// MASK64 在 lre-emu.js 内部定义，polyfill 需在其后使用 —— 用一个本地常量兜底。
header = header.replace(
  'class __Buf extends Uint8Array {',
  'const __MASK64 = (1n << 64n) - 1n;\nclass __Buf extends Uint8Array {',
).replace('& MASK64, true', '& __MASK64, true');
emu = header + emu;

// node:fs / node:path 不再可用
emu = emu.replace(/^const fs = require\('node:fs'\);.*$/m, 'const fs = {};');
emu = emu.replace(/^const path = require\('node:path'\);.*$/m, 'const path = { join: () => "" };');

// 指令表：静态 import
emu = emu.replace(/const EX_INSNS = require\('\.\/lre-insns'\);/, 'const EX_INSNS = __INSNS_EX_MOD;');
emu = emu.replace(/if \(!PK_INSNS\) PK_INSNS = require\(PK_INSNS_PATH\);/, 'if (!PK_INSNS) PK_INSNS = __INSNS_PK_MOD;');

// so 路径 → 逻辑标识
emu = emu.replace(/const EX_SO_PATH = [^\n]*\n/, 'const EX_SO_PATH = "ex";\n');
emu = emu.replace(/const PK_SO_PATH = [^\n]*\n/, 'const PK_SO_PATH = "pk";\n');

// soBufferFor：base64 → 字节（只解一次）
emu = emu.replace(
  /function soBufferFor\(p\) \{[\s\S]*?\n\}/,
  [
    'function soBufferFor(p) {',
    '  if (!__soCache[p]) __soCache[p] = __b64ToBytes(p === "pk" ? __SO_PK_B64 : __SO_EX_B64);',
    '  return __soCache[p];',
    '}',
  ].join('\n'),
);

// Buffer → Uint8Array
emu = emu.replace(/\bBuffer\.allocUnsafe\(/g, '__bufAlloc(');
emu = emu.replace(/\bBuffer\.alloc\(/g, '__bufAlloc(');
emu = emu.replace(/\bBuffer\.from\(/g, '__bufFrom(');

// 导出
emu = emu.replace(/module\.exports = \{[^}]*\};?/, 'export { calcT, Emu };');
if (!/export \{ calcT, Emu \};/.test(emu)) emu += '\nexport { calcT, Emu };\n';

emu = emu.replace(/\s+$/, '') + '\n';
w('emu.js', emu);

// ---------- 4) md5.js（纯 JS，Worker 的 WebCrypto 无 MD5） ----------
// 源文件 deploy/md5.src.js 是 CommonJS（便于本地自测），这里转成 ESM。
let md5 = fs.readFileSync(path.join(ROOT, 'deploy', 'md5.src.js'), 'utf8').replace(/\s+$/, '') + '\n';
md5 = md5.replace(/module\.exports\s*=\s*\{\s*md5\s*,\s*md5hex\s*\}\s*;?/, 'export { md5, md5hex };');
if (!/export \{ md5, md5hex \}/.test(md5)) md5 += '\nexport { md5, md5hex };\n';
w('md5.js', md5);

// ---------- 5) sign.js（4 轮 MD5 链条） ----------
w(
  'sign.js',
  [
    '// 自动生成：主域 sign（4 轮 MD5 链）—— Worker 版。',
    '// 用纯 JS MD5（Worker 的 WebCrypto 不支持 MD5），同步实现（省 CPU）。',
    "import { md5hex } from './md5.js';",
    '',
    "export const SALT = 'wdi4n2t8edr';",
    '',
    '/** 与原版 chainMd5 等价：s1=path+salt; d1=md5(s1); s2=s1+d1+path; …; sign=md5(s3+d3+salt)。 */',
    'export function chainMd5(urlPath, T) {',
    '  let s = urlPath + SALT;',
    '  let d = md5hex(s);',
    '  s = s + d + urlPath;',
    '  d = md5hex(s);',
    '  s = s + d + T;',
    '  d = md5hex(s);',
    '  return md5hex(s + d + SALT);',
    '}',
    '',
  ].join('\n'),
);

// ---------- 报告 ----------
console.log('已生成 ' + path.relative(ROOT, OUT) + '/：');
let total = 0;
for (const f of written) {
  total += f.size;
  console.log('  ' + f.name.padEnd(16) + (f.size / 1024).toFixed(0).padStart(6) + ' KB');
}
console.log('  ' + '合计'.padEnd(15) + (total / 1024).toFixed(0).padStart(6) + ' KB');
console.log('');
console.log('自检：');
const reqLeft = (emu.match(/\brequire\(/g) || []).length;
console.log('  emu.js 残留 require : ' + reqLeft + '（应为 0）');
console.log('  emu.js 有 export     : ' + /export \{ calcT, Emu \}/.test(emu));
console.log('  emu.js 用 atob 解码  : ' + /atob\(/.test(emu));
console.log('  emu.js 无 node:fs    : ' + !/require\('node:fs'\)/.test(emu));
console.log('  emu.js 无 Buffer.    : ' + !/\bBuffer\./.test(emu));
console.log('  md5.js 有 export     : ' + /export \{ md5, md5hex \}/.test(md5));
console.log('  md5.js 无 module.e   : ' + !/module\.exports/.test(md5));

const bad = reqLeft > 0 || !/export \{ calcT, Emu \}/.test(emu) || /\bBuffer\./.test(emu)
  || !/export \{ md5, md5hex \}/.test(md5) || /module\.exports/.test(md5);
console.log('');
console.log(bad ? '❌ 自检未通过' : '✅ 自检通过');
process.exit(bad ? 1 : 0);