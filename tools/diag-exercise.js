'use strict';
// 练习链路 417 诊断：拿真实账号 cookie，对同一端点跑多组参数组合，看服务端到底认什么。
//
// 用法：node tools/diag-exercise.js [leoAccountId]
//   不带参数则取库里第一个账号。

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { config } = require(path.join(ROOT, 'src', 'config'));
const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const { request } = require(path.join(ROOT, 'src', 'http'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));
const nativeLib = require(path.join(ROOT, 'src', 'native'));

db.init(config.dbFile);

function pickAccount() {
  const argId = Number(process.argv[2]);
  if (argId) {
    const a = db.getLeoAccount(argId);
    if (a) return a;
  }
  const rows = db.get().prepare('SELECT * FROM leo_accounts ORDER BY id DESC').all();
  if (!rows.length) throw new Error('库里没有账号');
  return db.getLeoAccount(rows[0].id);
}

const P = '/leo-star/android/exercise/homepage';

/** 手拼 URL（不经过 exercise.buildExerciseUrl，便于自由改参数）。 */
function url(path_, params, opts) {
  const o = opts || {};
  const q = [];
  if (o.noProductId !== true) q.push(['_productId', o.productId || '611']);
  q.push(['platform', o.platform || 'android37']);
  q.push(['version', o.version || '3.140.1']);
  q.push(['vendor', 'UC']);
  q.push(['deviceCategory', 'phone']);
  q.push(['av', '5']);
  q.push(['webviewVersion', '150']);
  q.push(['whRatio', '2.17']);
  q.push(['isBackground', '0']);
  for (const [k, v] of Object.entries(params || {})) q.push([k, String(v)]);
  if (o.sign) q.push(['sign', o.sign]);
  return config.leoBase + path_ + '?' + q.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

async function probe(jar, label, opts) {
  try {
    const r = await request({
      url: url(P, null, opts),
      method: 'GET',
      jar,
      headers: exercise.exerciseHeaders(),
      timeoutMs: 20000,
    });
    const blocked = r.headers['x-block-by'] || '';
    console.log(
      `[${String(r.status).padEnd(3)}] ${label.padEnd(34)} x-block-by=${blocked || '-'} body=${String(r.text).slice(0, 70).replace(/\s+/g, ' ')}`,
    );
    return r.status;
  } catch (e) {
    console.log(`[ERR] ${label.padEnd(34)} ${e.message}`);
    return null;
  }
}

(async () => {
  const acc = pickAccount();
  console.log('账号：', acc.id, acc.name || '(无名)');
  const jar = jobs.jarOf(acc);
  console.log('cookie 条数：', jar.items.length, '|', jar.items.map((c) => c.name).join(','));

  console.log('\n--- sign 能力自检 ---');
  let sign = null;
  try {
    sign = nativeLib.calcSign(P);
    console.log('native sign =', sign);
  } catch (e) {
    console.log('native sign 不可用：', e.message.split('\n')[0]);
  }

  console.log('\n--- 练习端点 A/B ---');
  await probe(jar, '当前默认（无 sign）', {});
  await probe(jar, '假 sign（32 个 0）', { sign: '0'.repeat(32) });
  if (sign) await probe(jar, '真 sign（native）', { sign });
  await probe(jar, 'version=3.141.1 无 sign', { version: '3.141.1' });
  await probe(jar, 'platform=android36 无 sign', { platform: 'android36' });
  await probe(jar, '无公共参数（裸路径）', { bare: true });

  console.log('\n--- 裸路径对照（不带任何 query）---');
  try {
    const r = await request({
      url: config.leoBase + P,
      method: 'GET', jar, headers: exercise.exerciseHeaders(), timeoutMs: 20000,
    });
    console.log('[', r.status, '] 裸路径  x-block-by=', r.headers['x-block-by'] || '-',
      ' body=', String(r.text).slice(0, 70).replace(/\s+/g, ' '));
  } catch (e) { console.log('裸路径失败：', e.message); }

  console.log('\n--- 对照：PK home（不需要 sign 的端点）---');
  const leo = require(path.join(ROOT, 'src', 'leo'));
  try {
    const r = await leo.pkHome(jar, 3);
    console.log('pkHome status =', r.status, '| userId=',
      r.json && r.json.baseUserInfoVO && r.json.baseUserInfoVO.userId);
  } catch (e) { console.log('pkHome 失败：', e.message); }
})();
