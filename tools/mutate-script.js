#!/usr/bin/env node
'use strict';
/**
 * 逐属性变异：拿**真机 script（能过）**，每次只改一个属性，找出判别因素。
 *
 * ## 为什么这样做
 *   我们的笔迹现在是「单笔 / 21 点 / 同期书写区」，
 *   与真机在肉眼可见的维度上已一致，但仍 400。
 *   而真机那份在同一道加法题上 200 且判对 10/10。
 *
 *   ⇒ 必有一个「肉眼看不见」的属性被服务端校验。
 *     用**受控变异**（不改其它）逐个排除，比继续猜快得多。
 *
 * ## 变异项（每次只改一处）
 *   0 真机原样                —— 基线（预期 200）
 *   1 小数位截断到 3          —— 测精度要求
 *   2 点密度减半（21→10）     —— 测「点太稀」
 *   3 点密度加倍（21→42）     —— 测「点太密」
 *   4 整体缩放 0.7            —— 测笔画尺寸
 *   5 整体平移 +30/+0         —— 测位置微调
 *   6 我们的（对照）          —— 预期 400
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
const REAL_SCRIPT = (REAL.questions || [])[0].script;
const REAL_PTS = JSON.parse(REAL_SCRIPT);   // [[{x,y},...]]

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(86)); line(t); line('='.repeat(86)); }

const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;

/** 把点集（[][]）序列化成 script 字符串。 */
const ser = (strokes) => JSON.stringify(strokes.map((st) => st.map((p) => ({ x: p.x, y: p.y }))));

function bbox(strokes) {
  const all = [];
  for (const st of strokes) for (const p of st) all.push(p);
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  return { x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs),
    y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys), n: all.length };
}

/** 每笔隔点取样（21→约 11）。 */
function decimate(strokes) {
  return strokes.map((st) => st.filter((p, i) => i % 2 === 0));
}

/** 线性插值加密（21→约 41）。 */
function densify(strokes) {
  return strokes.map((st) => {
    const out = [];
    for (let i = 0; i < st.length; i++) {
      out.push(st[i]);
      if (i + 1 < st.length) {
        out.push({ x: (st[i].x + st[i + 1].x) / 2, y: (st[i].y + st[i + 1].y) / 2 });
      }
    }
    return out;
  });
}

const MUT = {
  '0 真机原样': () => REAL_SCRIPT,
  '1 小数截断到 3 位': () => ser(REAL_PTS.map((st) => st.map((p) => ({ x: r3(p.x), y: r3(p.y) })))),
  '2 点密度减半': () => ser(decimate(REAL_PTS)),
  '3 点密度加倍': () => ser(densify(REAL_PTS)),
  '4 整体缩放 0.7': () => ser(REAL_PTS.map((st) => st.map((p) => ({
    x: r4(200 + (p.x - 200) * 0.7), y: r4(510 + (p.y - 510) * 0.7),
  })))),
  '5 平移 +30/0': () => ser(REAL_PTS.map((st) => st.map((p) => ({
    x: r4(p.x + 30), y: p.y,
  })))),
};

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

  const base = exercise.answerAll(ex, 200);
  line('  真机 script: 字节 ' + REAL_SCRIPT.length + '  点 ' + JSON.stringify(bbox(REAL_PTS)));
  const ob = bbox(JSON.parse(base.questions[0].script));
  line('  我们 script: 字节 ' + base.questions[0].script.length + '  点 ' + JSON.stringify(ob));
  line('  我们首点: ' + JSON.stringify(JSON.parse(base.questions[0].script)[0][0]));
  line('  真机首点: ' + JSON.stringify(REAL_PTS[0][0]));

  hr('逐项变异提交');
  // ★ 等待基准必须用「**出题成功**」时刻，不能用出题开始时刻。
  //   服务端校验的是「距出题成功过了多久」；若出题期间被 429 限流等了 50s，
  //   用开始时刻算会误以为「已等够了」而不等待，实际只过了 1s → 全 400。
  //   （exercise.js 里已用 matchOkAt 修过同一个坑，测试脚本也要一致。）
  const matchOkAt = Date.now();
  const wait = 300 + n * 200;
  if (wait - (Date.now() - matchOkAt) > 0) await sleep(wait - (Date.now() - matchOkAt));
  line('  出题成功→提交 间隔 ' + (Date.now() - matchOkAt) + 'ms（需 ≥ ' + wait + 'ms）');

  for (const name of Object.keys(MUT)) {
    const b = JSON.parse(JSON.stringify(base));
    const sc = MUT[name]();
    b.questions.forEach((q) => { q.script = sc; });
    const r = await exercise.submitExam(jar, ex.idString, b, {});
    const bb = bbox(JSON.parse(sc));
    line('  ' + name.padEnd(18) + ' 字节 ' + String(sc.length).padStart(4)
      + '  点 ' + String(bb.n).padStart(3)
      + '  → ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status)
      + (r.status === 200 ? '  判对 ' + ((r.json || {}).correctCnt) + '/' + n : ''));
    await sleep(1200);
  }

  hr('对照：我们的笔迹');
  const r = await exercise.submitExam(jar, ex.idString, base, {});
  line('  我们的 → ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status));
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });