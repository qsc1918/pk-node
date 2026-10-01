#!/usr/bin/env node
'use strict';
/*
 * 诊断：`homepage` 与 `rank/pre-fetch` 到底哪一个是「刷分的读数」。
 *
 * 背景：pk-node 的 `readScore()` 用 `rank/pre-fetch.curWeekScore`，
 * 而老挂移植时改用了 `homepage.curWeekExp` —— 两者取舍相反，必须钉死一个。
 *
 * 用法：node tools/diag-homepage-vs-prefetch.js [leoAccountId]
 */
const db = require('../src/db');
const { config } = require('../src/config');
db.init(config.dbFile);
const jobs = require('../src/jobs');
const ex = require('../src/exercise');

(async () => {
  const id = Number(process.argv[2]) || null;
  const accs = db.listLeoAccounts ? db.listLeoAccounts() : [];
  console.log('账号数:', accs.length);
  if (!accs.length) {
    console.log('库里没有小猿账号 —— 先在网页端添加');
    process.exit(0);
  }
  for (const acc of accs) {
    if (id && acc.id !== id) continue;
    const jar = jobs.jarOf(acc);
    console.log('\n===== 账号 id=' + acc.id + ' leoAccountId=' + (acc.leo_account_id || acc.leoAccountId) + ' =====');
    const hp = await ex.homepage(jar).catch((e) => ({ err: e.message }));
    console.log('homepage      :', JSON.stringify(hp));
    const pf = await ex.rankPrefetch(jar).catch((e) => ({ err: e.message }));
    console.log('rank/prefetch :', JSON.stringify(pf));
    const sc = await ex.readScore(jar);
    console.log('readScore()   :', sc);
  }
  process.exit(0);
})();
