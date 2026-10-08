#!/usr/bin/env node
'use strict';
/**
 * 决定性验证：服务端是否拒绝「每题笔迹完全相同」？
 *
 * ## 观察到的矛盾
 *   同一份**真机 script**（内容本身能过）：
 *     · isolate-script-form.js：每题取 `REAL_SCRIPTS[i % 10]`（**每题不同**）
 *       → ✅ 200 判对 10/10
 *     · mutate-script.js：`q.script = sc`（**10 题全同一份**）
 *       → ❌ 全 400（连「真机原样」也 400）
 *
 *   内容一样、结果相反 ⇒ 判别点在「**题与题之间的笔迹是否雷同**」。
 *
 * ## 这也解释了生产环境的失败
 *   我们的七段码**没有任何随机性**：
 *     - `buildPathPoints(answer, seed, 'ARC')` 遇数字会回落 `sevenSegmentPathPoints(answer)`
 *     - 而 `sevenSegmentPathPoints` **不接收 seed** → 答案相同的两题产生**逐字节相同**的 script
 *   KP=16（6~10 的加法）里答案重复率很高（如 `0+7` 与 `7+0` 都是 7）→ 雷同 → 400。
 *
 * ## 本实验（一次出题，四组对照）
 *   A 每题取不同真机 script          → 预期 200（复现成功）
 *   B 全部用同一份真机 script        → 预期 400（复现失败）
 *   C 我们的笔迹（现状，可能有重复）  → 看是否 400
 *   D 我们的笔迹 + 每题加不同扰动     → 若 200 则确认「必须每题不同」
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const NQ = Number(process.argv[4] || 10);

const REAL = JSON.parse(fs.readFileSync('/root/alinker/pk_body.json', 'utf8'));
const REAL_SCRIPTS = (REAL.questions || []).map((q) => q.script);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(86)); line(t); line('='.repeat(86)); }

/** 给一份 script 加一个小扰动（模拟不同次书写）。 */
function jitter(scriptStr, seed) {
  let arr;
  try { arr = JSON.parse(scriptStr); } catch (e) { return scriptStr; }
  const out = arr.map((st, si) => st.map((p, pi) => {
    // 用确定性伪随机，避免 Math.random 造成不可复现
    const n1 = Math.sin(seed * 12.9898 + si * 78.233 + pi * 37.719) * 43758.5453;
    const n2 = Math.sin(seed * 93.9898 + si * 67.345 + pi * 12.345) * 24634.6345;
    const dx = (n1 - Math.floor(n1) - 0.5) * 3.0;
    const dy = (n2 - Math.floor(n2) - 0.5) * 3.0;
    return { x: Math.round((p.x + dx) * 10000) / 10000, y: Math.round((p.y + dy) * 10000) / 10000 };
  }));
  return JSON.stringify(out);
}

/** 统计一份 body 里各题 script 的重复情况。 */
function dupInfo(body) {
  const seen = new Map();
  (body.questions || []).forEach((q) => {
    const k = String(q.script);
    seen.set(k, (seen.get(k) || 0) + 1);
  });
  const dup = Array.from(seen.values()).filter((v) => v > 1);
  return {
    unique: seen.size,
    total: (body.questions || []).length,
    maxRepeat: dup.length ? Math.max.apply(null, dup) : 1,
  };
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);

  hr('出题（加法题，答案易重复）');
  let g = null;
  for (let i = 0; i < 25; i++) {
    g = await exercise.getExam(jar, KP, NQ, {});
    if (g.status === 200) break;
    if (g.status !== 429) { line('  出题失败 ' + g.status); process.exit(0); }
    await sleep(3000);
  }
  if (!g || g.status !== 200) { line('  出题不成功'); process.exit(0); }
  const ex = g.json;
  const n = (ex.questions || []).length;
  line('  examId=' + ex.idString + '  题数=' + n);
  const answers = (ex.questions || []).map((q) => String(q.answer));
  line('  答案: ' + answers.join(' '));
  const ansCount = {};
  answers.forEach((a) => { ansCount[a] = (ansCount[a] || 0) + 1; });
  const repeats = Object.keys(ansCount).filter((k) => ansCount[k] > 1);
  line('  重复答案: ' + (repeats.map((k) => k + '×' + ansCount[k]).join(' ') || '（无）'));

  const ourBase = exercise.answerAll(ex, 200);
  line('  我们笔迹去重情况: ' + JSON.stringify(dupInfo(ourBase))
    + '   ← unique < total 就说明有重复');

  const t0 = Date.now();
  const wait = 300 + n * 200;
  if (wait - (Date.now() - t0) > 0) await sleep(wait - (Date.now() - t0));

  hr('四组对照');
  const cases = [
    { name: 'A 每题不同真机 script', mk: () => {
      const b = JSON.parse(JSON.stringify(ourBase));
      b.questions.forEach((q, i) => { q.script = REAL_SCRIPTS[i % REAL_SCRIPTS.length]; });
      return b;
    } },
    { name: 'B 全部同一份真机 script', mk: () => {
      const b = JSON.parse(JSON.stringify(ourBase));
      b.questions.forEach((q) => { q.script = REAL_SCRIPTS[0]; });
      return b;
    } },
    { name: 'C 我们的（现状）', mk: () => ourBase },
    { name: 'D 我们的 + 每题扰动', mk: () => {
      const b = JSON.parse(JSON.stringify(ourBase));
      b.questions.forEach((q, i) => { q.script = jitter(q.script, i + 1); });
      return b;
    } },
  ];

  for (const c of cases) {
    const b = c.mk();
    const di = dupInfo(b);
    const r = await exercise.submitExam(jar, ex.idString, b, {});
    line('  ' + c.name.padEnd(24)
      + ' 去重 ' + String(di.unique) + '/' + String(di.total)
      + '  → ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status)
      + (r.status === 200 ? '  判对 ' + ((r.json || {}).correctCnt) + '/' + n : ''));
    await sleep(1200);
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });