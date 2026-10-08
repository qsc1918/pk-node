#!/usr/bin/env node
'use strict';
/**
 * 决定性对照（加法题）：真机 script vs 我们 script，只差 script。
 *
 * ## 已排除
 *   · 坐标位置（tools/probe-answerbox-x.js：x 位移 0/150/275/350 全 400）
 *   · 等待时长（多种间隔都试过）
 *   · 字段缺失（与非缺失都试过）
 *
 * ## 本轮
 *   在**同一份加法题**（`4+5=\square`，答案 9）上：
 *     A 真机 script 原样（来自比较题，点位 x177~267 / y482~560）
 *     B 我们的 script（七段码，x191~241 / y478~548）
 *     C 真机 script 的**第一个笔画的点结构**，但数值替换成我们的
 *       （用于判断是「结构」还是「数值」问题）
 *
 *   若 A=200 而 B=400 → 差异在 script 的**内容特征**（而非位置/数量）
 *
 * ## 额外观察
 *   把两者的 script 原始字符串长度、点结构、小数位数并排打印，
 *   便于肉眼找差异。
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

/** 深比对两份 script 的结构差异。 */
function describe(scriptStr, label) {
  let arr;
  try { arr = JSON.parse(scriptStr); } catch (e) { line('  ' + label + ': 解析失败 ' + e.message); return; }
  const strokes = arr.map((st) => (st || []).length);
  const all = [];
  for (const st of arr) for (const p of (st || [])) all.push(p);
  const keys = new Set();
  all.forEach((p) => Object.keys(p).forEach((k) => keys.add(k)));
  const dec = all.map((p) => {
    const s = String(p.x);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  });
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  line('  ' + label);
  line('    字节 ' + scriptStr.length + '   笔 ' + arr.length + '（每笔 ' + strokes.join('/') + '）'
    + '   总点 ' + all.length);
  line('    点的键: ' + Array.from(keys).join(','));
  line('    小数位: 最多 ' + Math.max.apply(null, dec) + '  平均 '
    + (dec.reduce((a, b) => a + b, 0) / dec.length).toFixed(2));
  line('    x ' + Math.min.apply(null, xs).toFixed(2) + '~' + Math.max.apply(null, xs).toFixed(2)
    + '   y ' + Math.min.apply(null, ys).toFixed(2) + '~' + Math.max.apply(null, ys).toFixed(2));
  line('    首点: ' + JSON.stringify(all[0]));
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);

  hr('出题（加法题）');
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
  (ex.questions || []).slice(0, 3).forEach((q) => {
    line('    ' + JSON.stringify(q.content) + ' → ' + JSON.stringify(q.answer));
  });

  hr('script 形态对比');
  const ours = exercise.answerAll(ex, 200);
  describe(ours.questions[0].script, '我们的（七段码）');
  line('');
  describe(REAL_SCRIPTS[0], '真机（比较题，在加法题上能过）');

  hr('提交对照');
  const t0 = Date.now();
  const wait = 300 + n * 200;
  if (wait - (Date.now() - t0) > 0) await sleep(wait - (Date.now() - t0));

  const cases = [
    { name: 'A 真机 script 原样', mk: () => {
      const b = JSON.parse(JSON.stringify(ours));
      b.questions.forEach((q, i) => { q.script = REAL_SCRIPTS[i % REAL_SCRIPTS.length]; });
      return b;
    } },
    { name: 'B 我们的 script', mk: () => ours },
  ];

  for (const c of cases) {
    const r = await exercise.submitExam(jar, ex.idString, c.mk(), {});
    line('  ' + c.name.padEnd(22) + ' → ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status)
      + (r.status === 200 ? '   判对 ' + ((r.json || {}).correctCnt) + '/' + n : ''));
    if (r.status !== 200) {
      line('       ' + String(r.text || '').slice(0, 120).replace(/\s+/g, ' '));
    }
    await sleep(1200);
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });