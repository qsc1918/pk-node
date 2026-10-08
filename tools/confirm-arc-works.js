#!/usr/bin/env node
'use strict';
/**
 * 确认残存问题只在「数字字形」：用**比大小**知识点跑我们的 ARC 笔迹。
 *
 * ## 推理链
 *   · tools/isolate-script-form.js：真机 script → 200 判对 10/10；我们的 → 400
 *   · tools/measure-real-canvas.js：真机答案**全是** `>`/`<`（比大小题），
 *     而同一答案下我们的 ARC 与真机**几乎重合**：
 *         真机 `>`: x 177.9~267.7  y 482.3~560.2  21 点
 *         我们 `>`: x 151.7~242.7  y 483.7~560.6  21 点
 *   ⇒ 若 ARC 本身没问题，那 400 就出在**数字**（七段码字形）。
 *
 * ## 本实验
 *   用比大小知识点（答案 `>`/`<` → 走 ARC），提交 **我们生成的** script：
 *     · 200 → 证实「ARC 可用，问题只在数字字形」
 *     · 400 → ARC 也还需调整
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 235001);
const NQ = Number(process.argv[4] || 10);
const GAP = Number(process.argv[5] || 6000);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function match(jar) {
  for (let i = 0; i < 25; i++) {
    const g = await exercise.getExam(jar, KP, NQ, {});
    if (g.status === 200) return g;
    if (g.status !== 429) { line('  出题失败 ' + g.status + ': ' + String(g.text).slice(0, 90)); return null; }
    await sleep(10000);
  }
  return null;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 ' + acc.id + '  知识点 ' + KP + '（比大小）  题数 ' + NQ);

  const g = await match(jar);
  if (!g) { line('出题失败'); process.exit(0); }
  const ex = g.json;
  const ans = (ex.questions || []).map((q) => String(q.answer));
  line('  examId=' + ex.idString + '  keypoint=' + ex.keypoint);
  line('  答案: ' + ans.join(' '));

  // 用生产 answerAll 生成（ARC 对 >/< 生效）
  const body = exercise.answerAll(ex, 600);
  const sc0 = body.questions[0].script;
  let nPts = 0;
  try {
    const p = JSON.parse(sc0);
    nPts = p.reduce((k, st) => k + st.length, 0);
  } catch (e) { /* ignore */ }
  line('  script 长度 ' + sc0.length + '  总点 ' + nPts);

  const t0 = Date.now();
  const w = GAP - (Date.now() - t0);
  if (w > 0) await sleep(w);

  const r = await exercise.submitExam(jar, ex.idString, body, {});
  line('');
  line('  → ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status));
  if (r.status === 200) {
    line('     服务端判对 ' + ((r.json || {}).correctCnt) + '/' + ((r.json || {}).questionCnt));
    line('     ★ 证实：ARC（比较符）可用，残存问题只在数字字形。');
  } else {
    line('     ' + String(r.text || '').slice(0, 130).replace(/\s+/g, ' '));
    line('     ⇒ ARC 也需调整（不只是数字字形）。');
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });