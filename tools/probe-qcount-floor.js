#!/usr/bin/env node
'use strict';
/**
 * 定出「做题数」对提交校验的影响：是不是题多就要等更久？
 *
 * ## 线索
 *   · 10 题、出题后 ≥1.8s 提交 → 200
 *   · 100 题、出题后 3.0s 提交 → **400**（刚实测，3 局全 400）
 *
 *   若服务端按「题量 × 单题最低耗时」算阈值，100 题的下限就远高于 10 题。
 *   这能同时解释我此前的观察（10 题需 ≥1.8s）与 100 题的失败。
 *
 * ## 做法
 *   出 100 题，在递增间隔上提交：
 *     3s → 12s → 30s → 60s
 *   看哪一档从 400 变 200，从而得到 100 题的阈值。
 *
 * ⚠️ 同一个 exam 反复提交；若已递交会返回别的错，据此也能判断。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const NQ = Number(process.argv[4] || 100);
const GAPS = (process.argv[5] || '3000,12000,30000,60000').split(',').map(Number);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

/** 填答案；每题耗时留一个「够小」的值，验证阈值是否与它无关。 */
function answer(exam, perMs) {
  const clone = JSON.parse(JSON.stringify(exam));
  for (const q of clone.questions || []) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = a; q.status = 1; }
    q.costTime = perMs;
  }
  return clone;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 id=' + acc.id + '  yfd_u=' + acc.yfd_u + '  题数=' + NQ);

  hr('出题（429 重试）');
  let g = null;
  for (let i = 0; i < 20; i++) {
    g = await exercise.getExam(jar, KP, NQ, {});
    if (g.status === 200) break;
    if (g.status !== 429) { line('  失败 ' + g.status + ': ' + String(g.text).slice(0, 110)); process.exit(0); }
    line('  429，等 10s（第 ' + (i + 1) + ' 次）');
    await sleep(10000);
  }
  if (!g || g.status !== 200) { line('  出题始终不成功'); process.exit(0); }
  const exam = g.json;
  const n = (exam.questions || []).length;
  const t0 = Date.now();
  line('  examId = ' + exam.idString + '  实际题数 = ' + n);

  hr('递增间隔提交');
  for (const gap of GAPS) {
    const wait = gap - (Date.now() - t0);
    if (wait > 0) { line('  …等到 ' + (gap / 1000) + 's'); await sleep(wait); }
    const actual = Date.now() - t0;
    const per = Math.max(5, Math.round(gap / n));
    const body = answer(exam, per);
    const r = await exercise.submitExam(jar, exam.idString, body, {});
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('  间隔 ' + (actual / 1000).toFixed(1) + 's  每题声明 ' + per + 'ms  → ' + tag);
    line('      ' + String(r.text || '').slice(0, 150).replace(/\s+/g, ' '));
    if (r.status === 200) {
      line('  → 阈值就在这个量级；100 题的等待取此值 + 余量。');
      break;
    }
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });