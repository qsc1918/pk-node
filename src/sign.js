'use strict';
// sign 算法（纯 JS 实现 + 离线自校验）。
//
// ## 权威公式（已用原版真实请求逐字节验证）
//
//   s1 = path + salt
//   d1 = md5(s1)
//   s2 = s1 + d1 + path
//   d2 = md5(s2)
//   s3 = s2 + d2 + T
//   d3 = md5(s3)
//   sign = md5(s3 + d3 + salt)
//
// salt = "wdi4n2t8edr"，path = URL.encodedPath()（**不含 query**）。
//
// ## ⚠️ T 是「随当前分钟变化」的设备常量
//
// T 由 so 里一个 4.6KB 的函数生成（含 `time()`），**没有**用纯 JS 复现它。
// 因此线上计算 sign 统一走 native harness（`native.calcSign`，见 native.js），
// 本文件只负责：
//   1. 保存公式本身（可读、可审计、可离线验证）；
//   2. `verifyWithFixture()` 用一份固定的 (T, path, sign) 三元组自证公式正确。
//
// 这样即使将来 native 资产换了设备，公式仍然是对的，出问题只需重取 T。

const crypto = require('node:crypto');

/** 硬编码 salt（so 内常量，勿改）。 */
const SALT = 'wdi4n2t8edr';

/** md5 → 32 位小写 hex。 */
function md5(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex');
}

/**
 * 按权威公式算 sign。
 *
 * @param {string} urlPath 只含路径（如 `/leo-game-pk/android/math/pk/submit`）
 * @param {string} T       设备时间派生串（从设备 so 取出，随分钟变化）
 * @param {string} [salt]  salt，默认 `wdi4n2t8edr`
 * @returns {string} 32 位小写 hex
 */
function chainMd5(urlPath, T, salt = SALT) {
  const p = String(urlPath);
  const s1 = p + salt;
  const d1 = md5(s1);
  const s2 = s1 + d1 + p;
  const d2 = md5(s2);
  const s3 = s2 + d2 + T;
  const d3 = md5(s3);
  return md5(s3 + d3 + salt);
}

/**
 * 离线自校验：用历史真机抓下来的固定样本验证公式。
 *
 * 样本来源：设备 so 的 dump 输出（`T=` 与 `SIGN=`），path 见下。
 * 这条样本曾在逆向阶段用于定位公式，留下它可防「后人把公式改坏」。
 *
 * @returns {{ok:boolean, expect:string, got:string}}
 */
function verifyWithFixture() {
  const fixture = {
    path: '/leo-goblin-mall/android/goods/click-read/display',
    T:
      '33154662983921571729839231298392151949946399298391916271265449731992983921533554432459678392983923159678391704973199175967839994639929839215192983920117298391697171742102219521729839117174210221952172983916916777216252983920129839200162295323172983920033554432298391917167772164973199162502486599298391229532329839215497319929839215994639933154672486599596783927126541617733154661759678397596783999463993315467',
    sign: 'e4e851febf67146e2db256a78d6ec357',
  };
  const got = chainMd5(fixture.path, fixture.T);
  return { ok: got === fixture.sign, expect: fixture.sign, got: got };
}

module.exports = { SALT, md5, chainMd5, verifyWithFixture };