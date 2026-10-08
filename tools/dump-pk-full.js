#!/usr/bin/env node
'use strict';
/**
 * 把 pkMatchV2 的**全部顶层字段**写进文件，供完整查看。
 *
 * 上一版用 tail 查看，开头被截掉了，漏看了关键字段。
 * 写文件更保险。
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const ACC_ID = Number(process.argv[2] || 15);
const POINT_ID = Number(process.argv[3] || 1959);
const OUT = process.argv[4] || '/tmp/pk-match-dump.txt';

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);

  let m = null;
  for (let i = 0; i < 12; i++) {
    m = await leo.pkMatchV2(jar, POINT_ID, {});
    if (m.status === 200 && m.json) break;
    if (m.status !== 429 && m.status !== 400) { line('出题失败 ' + m.status); process.exit(0); }
    line('出题 ' + m.status + '，等 10s');
    await sleep(10000);
  }
  if (!m || m.status !== 200 || !m.json) { line('出题不成功'); process.exit(0); }

  const r = m.json;
  const ev = r.examVO || {};
  const qs = ev.questions || [];

  const out = [];
  out.push('=== pkMatchV2 顶层字段（除 examVO，含完整值）===');
  for (const k of Object.keys(r)) {
    if (k === 'examVO') continue;
    const v = r[k];
    const t = v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v);
    out.push('  ' + k.padEnd(20) + t.padEnd(8) + JSON.stringify(v));
  }
  out.push('');
  out.push('=== examVO 字段（除 questions，含完整值）===');
  for (const k of Object.keys(ev)) {
    if (k === 'questions') continue;
    const v = ev[k];
    const t = v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v);
    out.push('  ' + k.padEnd(20) + t.padEnd(8) + JSON.stringify(v));
  }
  out.push('');
  out.push('=== question[0] 全部字段（含完整值）===');
  if (qs[0]) {
    for (const k of Object.keys(qs[0])) {
      const v = qs[0][k];
      const t = v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v);
      out.push('  ' + k.padEnd(20) + t.padEnd(8) + JSON.stringify(v).slice(0, 200));
    }
  }
  out.push('');
  out.push('=== 出题响应的原始字节数 = ' + Buffer.byteLength(JSON.stringify(r)) + ' ===');

  fs.writeFileSync(OUT, out.join('\n'), 'utf8');
  line('已写入 ' + OUT + '（' + out.length + ' 行）');
  line('顶层字段数 = ' + (Object.keys(r).length - 1) + '，examVO 字段数 = ' + (Object.keys(ev).length - 1));
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });