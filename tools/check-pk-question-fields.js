#!/usr/bin/env node
'use strict';
/**
 * 检查：pkMatchV2 返回的题目字段，是否有**提交时被丢掉**的。
 *
 * ## 为什么查这个
 *   PK 的 400 已排除：body 结构（与 09-27 真机样本逐字段一致）、
 *   时间间隔（3/9/20s 全 400）、请求形态（4 种变体全 400）。
 *
 *   剩下的高概率原因：**服务端 3.141.1 改了 QuestionVO**，
 *   题目里出现了新字段，而 `buildSubmitBody` 只映射了 12 个固定字段
 *   → 回传时缺了新字段 → 反序列化失败 → 400 `error`。
 *   （练习那边就是同类问题：多了个自造字段就 400。）
 *
 * ## 做法
 *   出题 → 打印原始 `examVO.questions[0]` 的**全部**键与值 →
 *   再打印 `buildSubmitBody` 产出的键 →
 *   求差集，即为「被丢掉的字段」。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const leo = require(path.join(ROOT, 'src', 'leo'));
const engine = require(path.join(ROOT, 'src', 'pk-engine'));

const ACC_ID = Number(process.argv[2] || 15);
const POINT_ID = Number(process.argv[3] || 1959);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);

  hr('出题');
  let m = null;
  for (let i = 0; i < 12; i++) {
    m = await leo.pkMatchV2(jar, POINT_ID, {});
    if (m.status === 200 && m.json) break;
    if (m.status !== 429 && m.status !== 400) { line('  出题失败 ' + m.status); process.exit(0); }
    line('  ' + m.status + '，等 10s');
    await sleep(10000);
  }
  if (!m || m.status !== 200 || !m.json) { line('  出题不成功'); process.exit(0); }

  const root = m.json;
  const examVO = root.examVO || {};
  line('  顶层键: ' + Object.keys(root).join(', '));
  line('  examVO 键: ' + Object.keys(examVO).join(', '));
  const qs = examVO.questions || [];
  line('  题数: ' + qs.length);
  if (!qs.length) { line('  没有题目'); process.exit(0); }

  hr('服务端给的 question[0]（原始）');
  const raw = qs[0];
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    const t = v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v);
    line('  ' + k.padEnd(20) + ' ' + t.padEnd(8) + String(JSON.stringify(v)).slice(0, 80));
  }

  hr('我们提交的 question[0]（buildSubmitBody 产出）');
  const body = engine.buildSubmitBody(m.json, { costTimeMs: 100, seedBase: 1, strokeMode: 'ARC' });
  const out = body.questions[0];
  for (const k of Object.keys(out)) {
    const v = out[k];
    const t = v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v);
    line('  ' + k.padEnd(20) + ' ' + t.padEnd(8) + String(JSON.stringify(v)).slice(0, 80));
  }

  hr('差异');
  const rawKeys = Object.keys(raw);
  const outKeys = Object.keys(out);
  const dropped = rawKeys.filter((k) => !outKeys.includes(k));
  const added = outKeys.filter((k) => !rawKeys.includes(k));
  line('  服务端有、我们没回传（**疑似元凶**）: ' + (dropped.length ? dropped.join(', ') : '（无）'));
  line('  我们有、服务端没给（自造字段）    : ' + (added.length ? added.join(', ') : '（无）'));
  line('');
  line('  顶层对比：');
  const realTop = root;
  const ourTop = body;
  const droppedTop = Object.keys(realTop).filter((k) => !Object.keys(ourTop).includes(k));
  const addedTop = Object.keys(ourTop).filter((k) => !Object.keys(realTop).includes(k));
  line('    服务端有、我们没回传: ' + (droppedTop.length ? droppedTop.join(', ') : '（无）'));
  line('    我们有、服务端没给  : ' + (addedTop.length ? addedTop.join(', ') : '（无）'));
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });