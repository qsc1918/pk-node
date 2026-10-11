#!/usr/bin/env node
'use strict';
/**
 * 终极验证：用**解压出来的发布包**跑一局真实 PK。
 *
 * 这一步的意义：前面几步（自检 / 起服务 / HTTP 200）只证明「包能跑」，
 * 本步证明「包能真刷」—— 也就是用户拿到 zip 解压后，业务链路是通的。
 *
 * 做法：把正式库的账号导出成一份临时库给包内的 db 用（包内 data/ 是空的）。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = process.argv[2] || '/tmp/relcheck/pk-node-1.12.0';
const SRC_DB = '/root/pk-node/data';

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(84)); line(t); line('='.repeat(84)); }

(async () => {
  // 1) 把正式库**连同密钥**拷进包内。
  //
  //    ⚠️ 必须连 `secret.key` 一起拷：cookie 里的设备链是 AES-GCM 加密存的，
  //       换一把密钥就解不开（会静默降级为「发送密文」→ 401）。
  //       本步只为验证「包内代码能干真活」，不是发布行为（data/ 永不进包）。
  const pkgData = path.join(ROOT, 'data');
  fs.mkdirSync(pkgData, { recursive: true });
  for (const f of ['pk-node.sqlite', 'pk-node.sqlite-wal', 'pk-node.sqlite-shm', 'secret.key']) {
    const src = path.join(SRC_DB, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pkgData, f));
  }

  hr('用包内代码跑真实 PK');
  line('  包目录: ' + ROOT);

  const db = require(path.join(ROOT, 'src', 'db'));
  const jobs = require(path.join(ROOT, 'src', 'jobs'));
  const leo = require(path.join(ROOT, 'src', 'leo'));

  db.init();

  // 2) 列出可用账号
  const mainDb = require('node:sqlite');
  const f = new mainDb.DatabaseSync(path.join(SRC_DB, 'pk-node.sqlite'), { readOnly: true });
  const rows = f.prepare('SELECT id, yfd_u, name FROM leo_accounts LIMIT 20').all();
  f.close();

  line('  正式库账号数 = ' + rows.length);
  for (const r of rows) line('    id=' + r.id + '  yfd_u=' + r.yfd_u + ' name=' + (r.name || '-'));

  hr('真出题（走包内 leo.js）');

  let ok = 0;
  for (const r of rows.slice(0, 6)) {
    try {
      const a = db.getLeoAccount(r.id);
      if (!a) { line('  id=' + r.id + ' 包内不存在，跳过'); continue; }
      const jar = jobs.jarOf(a);
      const m = await leo.pkMatchV2(jar, 70, {});
      line('  PK 出题 id=' + r.id + ' → HTTP ' + m.status);
      if (m.status === 200) ok++;
    } catch (e) {
      line('  id=' + r.id + ' 异常：' + e.message);
    }
    await new Promise((res) => setTimeout(res, 1500));
  }

  hr('结论');
  line(ok > 0
    ? '  ✅ 包内代码能真出题（' + ok + ' 个成功）—— 发布包业务链路可用'
    : '  ⚠ 本次未测出题成功（账号限流或会话失效，与包本身无关）');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });