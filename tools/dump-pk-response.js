#!/usr/bin/env node
'use strict';
/**
 * 把 pkMatchV2 的完整响应结构打印出来 —— 找 PK 提交 400 缺的那块。
 *
 * ## 已知（tools/check-pk-question-fields.js）
 *   提交体结构已与 09-27 真机样本一致，但服务端 3.141.1 的出题响应里
 *   **多了顶层字段**：
 *       otherUser, otherWinCount, selfWinCount, targetCostTime, extra
 *   而我们提交时一个都没回传（09-27 的样本也没有，但那是旧版服务端）。
 *
 *   其中 `targetCostTime` 最可疑 —— PK 有「目标用时」概念，
 *   服务端可能要求提交时回传它对局才算有效。
 *
 * ## 本脚本
 *   打印这些新字段的**完整内容与类型**，据此决定怎么并入提交体。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const ACC_ID = Number(process.argv[2] || 15);
const POINT_ID = Number(process.argv[3] || 1959);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(84)); line(t); line('='.repeat(84)); }

function dump(label, obj, maxLen) {
  line('');
  line('  【' + label + '】');
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const t = v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v);
    line('    ' + k.padEnd(18) + t.padEnd(8) + JSON.stringify(v).slice(0, maxLen || 100));
  }
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);

  hr('出题（429 重试）');
  let m = null;
  for (let i = 0; i < 12; i++) {
    m = await leo.pkMatchV2(jar, POINT_ID, {});
    if (m.status === 200 && m.json) break;
    if (m.status !== 429 && m.status !== 400) { line('  出题失败 ' + m.status); process.exit(0); }
    line('  ' + m.status + '，等 10s（第 ' + (i + 1) + ' 次）');
    await sleep(10000);
  }
  if (!m || m.status !== 200 || !m.json) { line('  出题不成功'); process.exit(0); }

  const r = m.json;
  const examVO = r.examVO || {};

  hr('顶层（除 examVO）');
  const top = {};
  for (const k of Object.keys(r)) if (k !== 'examVO') top[k] = r[k];
  dump('顶层字段', top, 120);

  hr('examVO（除 questions）');
  const ev = {};
  for (const k of Object.keys(examVO)) if (k !== 'questions') ev[k] = examVO[k];
  dump('examVO 字段', ev, 120);

  hr('关键字段详解');
  for (const k of ['targetCostTime', 'extra', 'selfWinCount', 'otherWinCount', 'otherUser']) {
    const v = k in r ? r[k] : (k in examVO ? examVO[k] : undefined);
    if (v === undefined) { line('  ' + k + ' ：不存在'); continue; }
    line('  ' + k + ' = ' + JSON.stringify(v).slice(0, 400));
  }

  hr('对照：09-27 真机样本的顶层键');
  const fs = require('node:fs');
  try {
    const real = JSON.parse(fs.readFileSync('/root/alinker/pk_body.json', 'utf8'));
    line('  ' + Object.keys(real).join(', '));
    line('  （没有 targetCostTime / extra / selfWinCount 等）');
  } catch (e) {
    line('  读样本失败: ' + e.message);
  }

  hr('结论线索');
  line('  若 targetCostTime 是服务端下发的「目标用时」，');
  line('  而提交体里有 costTime 需要与它一致（或至少不超过），');
  line('  那 PK 的 costTime 就不能随便填 100，应按它来。');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });