#!/usr/bin/env node
'use strict';
/**
 * 找「cookie 仍然有效」的账号 —— 用于端到端验证退登真能清掉会话。
 *
 * 判据：`currentIdentity(jar)` 能读回非 null 的 userId。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const la = require(path.join(ROOT, 'src', 'services', 'leo-accounts'));

const IDS = (process.argv[2] || '15,22,28,36').split(',').map(Number);

(async () => {
  db.init();
  for (const id of IDS) {
    const a = db.getLeoAccount(id);
    if (!a) { console.log('id=' + id + ' 不存在'); continue; }
    let out;
    try {
      const cur = await la.currentIdentity(jobs.jarOf(a));
      out = '身份=' + JSON.stringify(cur);
    } catch (e) {
      out = '读失败 ' + e.message;
    }
    console.log('id=' + String(id).padEnd(4) + (a.name || '').slice(0, 12).padEnd(14) + out);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });