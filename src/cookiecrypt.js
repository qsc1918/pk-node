'use strict';
/**
 * cookie 值加密（落库用）。cookie 含设备链 `ks_*` 与登录态 `sess`，不能明文落库。
 * 方案：AES-256-GCM（带认证），只加密 value，name/domain/path 保持明文。
 * 格式：`enc:v1:<b64 iv(12B)>:<b64 tag(16B)>:<b64 ciphertext>`；
 * 无该前缀 = 明文（历史数据），下次写入即加密。
 * 密钥：PK_SECRET（≥16 字符）→ sha256；否则 data/secret.key（32 随机字节，0600）。
 * ⚠️ 密钥文件不要提交仓库；丢了密钥 = 已加密的 cookie 无法解密。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('./config');

const PREFIX = 'enc:v1:';
let cachedKey = null;

/** 解析/生成 32 字节密钥。 */
function key() {
  if (cachedKey) return cachedKey;
  const secret = process.env.PK_SECRET;
  if (secret && String(secret).length >= 16) {
    cachedKey = crypto.createHash('sha256').update(String(secret), 'utf8').digest();
    return cachedKey;
  }
  const keyFile = path.join(path.dirname(config.dbFile), 'secret.key');
  try {
    const buf = fs.readFileSync(keyFile);
    if (buf.length === 32) { cachedKey = buf; return cachedKey; }
  } catch (e) { /* 不存在则生成 */ }
  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, fresh, { mode: 0o600 });
  try { fs.chmodSync(keyFile, 0o600); } catch (e) { /* 某些文件系统不支持 */ }
  cachedKey = fresh;
  return cachedKey;
}

/** 明文 → `enc:v1:...`。空值原样返回（不加密空串）。 */
function encryptValue(plain) {
  const s = plain == null ? '' : String(plain);
  if (s.length === 0) return s;
  if (s.startsWith(PREFIX)) return s;                 // 已加密，幂等
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return PREFIX + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}

/** `enc:v1:...` → 明文。非密文（旧数据）原样返回。解密失败返回原值（不至于整库打不开）。 */
function decryptValue(stored) {
  const s = stored == null ? '' : String(stored);
  if (!s.startsWith(PREFIX)) return s;
  try {
    const parts = s.slice(PREFIX.length).split(':');
    if (parts.length !== 3) return '';
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const ct = Buffer.from(parts[2], 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) {
    return '';                                        // 密钥不对/数据损坏
  }
}

/** [{name,value,domain,path}] → 值全部加密（用于落库）。 */
function encryptItems(items) {
  if (!Array.isArray(items)) return items;
  return items.map((c) => Object.assign({}, c, { value: encryptValue(c.value) }));
}

/** [{name,value,...}] → 值全部解密（用于读取）。 */
function decryptItems(items) {
  if (!Array.isArray(items)) return items;
  return items.map((c) => Object.assign({}, c, { value: decryptValue(c.value) }));
}

/** 自检：加解密往返 + 密文不含明文。 */
function selfTest() {
  const plain = 'ks_u=demo-value-1234567890';
  const enc = encryptValue(plain);
  const back = decryptValue(enc);
  const ok = enc.startsWith(PREFIX) && back === plain && enc.indexOf('demo-value') < 0;
  return {
    ok: ok,
    mode: process.env.PK_SECRET ? 'PK_SECRET' : 'data/secret.key',
    detail: ok ? 'AES-256-GCM 往返一致，密文不含明文' : '加解密自检失败',
    sample: enc.slice(0, 24) + '…',
  };
}

module.exports = { PREFIX, encryptValue, decryptValue, encryptItems, decryptItems, selfTest };