'use strict';
// sign / T 链路的 Node 侧回归测试（与 tools/emu-selftest.py 同一判据）。
//
// 判据：`src/sign.js` 的真机 fixture 对应分钟 M = 29839199，
//       `calcT(M*60)` 必须与 fixture 的 T **逐字节一致**，且 chainMd5 复算出的
//       sign 必须等于 fixture 的 sign。
//
// 用法：node tools/sign-selftest.js

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { calcT } = require(path.join(ROOT, 'src', 'lre-emu'));
const { chainMd5 } = require(path.join(ROOT, 'src', 'sign'));

const FIXTURE_M = 29839199;

const src = fs.readFileSync(path.join(ROOT, 'src', 'sign.js'), 'utf8');
const i = src.indexOf('T:');
const j = src.indexOf('sign:', i);
const T_fix = (src.slice(i, j).match(/'([0-9]+)'/g) || []).map((s) => s.slice(1, -1)).join('');
const signFix = /sign:\s*'([0-9a-f]{32})'/.exec(src.slice(j))[1];
const urlPath = /path:\s*'([^']+)'/.exec(src)[1];

let ok = true;
const sim = calcT(FIXTURE_M * 60);
console.log('fixture T 长度 =', T_fix.length, '| 模拟 T 长度 =', sim.length);
if (sim === T_fix) {
  console.log('✅ calcT 与真机 fixture 逐字节一致');
} else {
  ok = false;
  let k = 0;
  while (k < sim.length && sim[k] === T_fix[k]) k++;
  console.log('❌ 首个差异 @' + k + ': 模拟=' + sim.slice(k, k + 20) + ' 真机=' + T_fix.slice(k, k + 20));
}

const sign = chainMd5(urlPath, T_fix);
console.log('chainMd5(fixture) =', sign);
console.log('fixture sign      =', signFix);
if (sign !== signFix) {
  ok = false;
  console.log('❌ sign 公式与 fixture 不符');
}

console.log();
console.log('结果:', ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
