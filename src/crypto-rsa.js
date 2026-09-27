'use strict';
// 手机号 / 密码 / 验证码的 RSA 编码器（复刻原版 Lkv/k 的加密分支）。
//
// ## 算法（逐行对照 smali 确证）
//
//   Cipher("RSA/ECB/PKCS1PADDING") + ENCRYPT_MODE
//   → 硬编码 X509 公钥（1024 位）
//   → doFinal(str.getBytes("UTF-8"))
//   → Base64（标准字母表，NO_WRAP）
//
// PKCS#1 v1.5 自带随机填充，所以**同一手机号每次密文都不同**，这是预期行为。
//
// ## 哪些字段要加密（别想当然统一处理）
//
// | 接口 | 字段 | 加密？ |
// |---|---|---|
// | `/verifier/android/sms` | `phone` | **是** |
// | `/accounts/android/safe/login`（短信） | `phone` | **是** |
// | `/accounts/android/safe/login`（短信） | `verification` | **是**（容易漏） |
// | `/accounts/android/safe/login`（密码） | `phone` | **否**（明文） |
// | `/accounts/android/safe/login`（密码） | `password` | **是** |
//
// ## 为什么不用仓库里那份 Java 实现
//
// 原项目 `PhoneEncoder.kt` 走 Android 的 `Cipher` + `android.util.Base64`。
// Node 没有这些，但 `node:crypto` 原生支持 RSA PKCS#1：
//   crypto.createPublicKey({key: der, format:'der', type:'spki'})
//   crypto.publicEncrypt({key, padding: RSA_PKCS1_PADDING}, buf)
// 输出与 Java 的 `Base64.NO_WRAP` 同为标准 Base64（无换行）。

const crypto = require('node:crypto');

/**
 * 原版硬编码公钥（X509 SubjectPublicKeyInfo，DER 的 Base64）。
 * 来源：`kv/k.smali` 静态字段 `a`。
 */
const PUBLIC_KEY_BASE64 =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDSovT1rrwzrGoMCFb6z8e+5lzVdAD5o8krGIwdfxrV' +
  'E2OnMijUZdkQk7etPJvZ2JOVXghthAGUUJkDUE8n2ZMNFKPjMrQJI49ewVzqWOKOvgU6Iu60Sn0xpei' +
  'etP1wWXBkszdV1WfNBJUo2hhPDnIPMGzzdfLW5rMu+tczeUriJQIDAQAB';

/** 公钥只解析一次。 */
let cachedKey = null;

function publicKey() {
  if (!cachedKey) {
    cachedKey = crypto.createPublicKey({
      key: Buffer.from(PUBLIC_KEY_BASE64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  }
  return cachedKey;
}

/**
 * RSA 加密（Base64 输出）。
 *
 * @param {string} plain 明文（手机号 / 验证码 / 密码）
 * @returns {string} 标准 Base64（172 字符 / 128 字节密文）
 */
function encrypt(plain) {
  const buf = Buffer.from(String(plain), 'utf8');
  const out = crypto.publicEncrypt(
    { key: publicKey(), padding: crypto.constants.RSA_PKCS1_PADDING },
    buf,
  );
  return out.toString('base64');
}

/** 中国大陆手机号：11 位、1 开头、第二位 3-9。 */
const PHONE_RE = /^1[3-9]\d{9}$/;

/** 校验手机号格式（前端也校验，但服务端必须自己再校验一遍）。 */
function isValidPhone(phone) {
  return PHONE_RE.test(String(phone || '').trim());
}

/** 验证码：4~8 位数字。 */
const CODE_RE = /^\d{4,8}$/;

function isValidCode(code) {
  return CODE_RE.test(String(code || '').trim());
}

/** 自检：公钥可解析 + 加密长度符合 1024 位 PKCS#1 预期（128 字节）。 */
function selfTest() {
  try {
    const sample = encrypt('18723143414');
    const len = Buffer.from(sample, 'base64').length;
    if (len !== 128) return { ok: false, detail: '密文长度异常：' + len };
    return { ok: true, detail: 'RSA 1024 / PKCS#1 可用（密文 128B）' };
  } catch (e) {
    return { ok: false, detail: 'RSA 编码失败：' + e.message };
  }
}

module.exports = { PUBLIC_KEY_BASE64, encrypt, isValidPhone, isValidCode, selfTest };