#!/usr/bin/env node
'use strict';
/**
 * 验证「退账号先发包」是否真的打出了两条 logout 请求。
 *
 * ## 为什么不能用「本地删没删」来验
 *   本地删库本来就成功 —— 那正是之前的错误行为。
 *   要看的是**有没有真发包**、服务端回了什么。
 *
 * ## 用法
 *   node tools/verify-logout.js <账号id> [--real]
 *
 *   --real  真删（会用 ?keepLocal=1 保留本地记录，只验退登）
 *   默认     演示模式：只调 leo.logout() 打印两条链路的状态码，不碰库
 *
 * ⚠️ 退登会**作废该账号的服务端会话**，之后要重新登录才可用。
 *    默认走演示模式（真发包但保留本地记录），便于反复验证。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const ACC_ID = Number(process.argv[2] || 15);
const REAL = process.argv.indexOf('--real') >= 0;

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(84)); line(t); line('='.repeat(84)); }

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号 ' + ACC_ID); process.exit(1); }

  line('账号 id=' + acc.id + '  name=' + (acc.name || '-'));
  line('模式: ' + (REAL ? '真删（先退登再删库）' : '演示（只退登，保留本地记录）'));
  line('');
  line('⚠️ 退登会作废该账号的**服务端会话**，之后需重新登录。');

  hr('① 退登前：确认当前身份（说明会话有效）');
  const jar = jobs.jarOf(acc);
  try {
    const cur = await require(path.join(ROOT, 'src', 'services', 'leo-accounts')).currentIdentity(jar);
    line('  当前身份: ' + JSON.stringify(cur).slice(0, 200));
  } catch (e) {
    line('  读身份失败（可能已失效）: ' + e.message);
  }

  hr('② 发包退登（两条链路）');
  const r = await leo.logout(jar, {});
  for (const a of r.attempts) {
    const tag = a.error ? ('异常 ' + a.error)
      : (a.status === 200 ? '✅ 200'
        : (a.status === 401 || a.status === 404 ? '⚠️ ' + a.status + '（会话已无）' : '❌ ' + a.status));
    line('  POST ' + a.host.padEnd(5) + a.path.padEnd(34) + ' → ' + tag);
  }
  line('');
  line('  汇总 ok=' + r.ok);

  hr('③ 退登后：再读身份（应已失效）');
  try {
    const cur2 = await require(path.join(ROOT, 'src', 'services', 'leo-accounts')).currentIdentity(jar);
    line('  当前身份: ' + JSON.stringify(cur2).slice(0, 200));
    line('  （若与退登前相同，说明服务端未清会话 —— 需复核）');
  } catch (e) {
    line('  读身份失败 → 会话已清 ✅（' + e.message + '）');
  }

  hr(REAL ? '④ 真删（走 server 路由逻辑）' : '④ 演示模式：不删本地记录');
  if (REAL) {
    db.deleteLeoAccount(acc.id);
    line('  已删除本地记录 id=' + acc.id);
  } else {
    line('  本地记录保留。要真删请加 --real。');
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });