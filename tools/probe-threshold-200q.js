#!/usr/bin/env node
'use strict';
/**
 * 一次实验同时回答两个关键问题（决定「100s 能否变短」）：
 *
 * ## 问题 1：200 题的**真实**提交下限是多少？
 *   用户给的系数是 0.5s/题（200 题 = 100s）。但 100s 太长。
 *   实测阈值，看能否显著低于 0.5s/题。
 *   注意：不只看「是否 200」，还要看 **correctCnt** ——
 *   若 correctCnt 被压成 0，提交虽 200 但**不入账**，等于没用。
 *
 * ## 问题 2：出题冷却会不会被「提交等待」覆盖？
 *   冷却从「上次出题**成功**」起算，实测约 58s。
 *   若提交等待 100s > 58s，那么**下一轮出题应当立即成功**，
 *   不必再等 58s —— 那每局就能从 ~158s 降到 ~100s。
 *
 * ## 做法（单次出题，多次提交同一 exam —— 已验证服务端允许）
 *   出题 → 在 t=20/45/75/105s 各提交一次 → 记录状态与判对数
 *   最后一次提交后**立即**出题，记录是否 429、等了多久。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const NQ = Number(process.argv[4] || 200);
const MARKS = (process.argv[5] || '20000,45000,75000,105000').split(',').map(Number);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }
const sec = (ms) => (ms / 1000).toFixed(1) + 's';

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 ' + acc.id + '  知识点 ' + KP + '  题数 ' + NQ);
  line('提交时间点: ' + MARKS.map(sec).join(', '));

  // ---------- 出题 ----------
  hr('① 出题');
  const tMatchStart = Date.now();
  let g = null;
  for (let i = 0; i < 30; i++) {
    g = await exercise.getExam(jar, KP, NQ, {});
    if (g.status === 200) break;
    if (g.status !== 429) { line('  出题失败 ' + g.status + ': ' + String(g.text).slice(0, 90)); process.exit(0); }
    await sleep(2000);
  }
  if (!g || g.status !== 200) { line('  出题失败'); process.exit(0); }
  const tMatchOk = Date.now();
  const ex = g.json;
  const n = (ex.questions || []).length;
  line('  examId=' + ex.idString + '  题数=' + n);
  line('  出题耗时 ' + sec(tMatchOk - tMatchStart) + '（含 429 重试）');
  const ans = (ex.questions || []).map((q) => String(q.answer));
  const rep = {};
  ans.forEach((a) => { rep[a] = (rep[a] || 0) + 1; });
  const dupAns = Object.keys(rep).filter((k) => rep[k] > 1);
  line('  答案重复: ' + (dupAns.map((k) => k + '×' + rep[k]).join(' ') || '（无）') + ' → 笔迹必须题题不同');

  const body = exercise.answerAll(ex, 200);
  const uniq = new Set(body.questions.map((q) => String(q.script))).size;
  line('  笔迹去重: ' + uniq + '/' + n + (uniq === n ? '  ✅' : '  ❌ 会因雷同被拒'));

  // ---------- 提交阈值梯度 ----------
  hr('② 提交阈值梯度（同一 exam 多次提交）');
  line('  时间点      间隔/题    状态   服务端判对');
  const results = [];
  for (const mark of MARKS) {
    const left = mark - (Date.now() - tMatchOk);
    if (left > 0) await sleep(left);
    const elapsed = Date.now() - tMatchOk;
    const r = await exercise.submitExam(jar, ex.idString, body, {});
    const per = Math.round(elapsed / n);
    const cc = r.status === 200 ? ((r.json || {}).correctCnt) : '-';
    line('  t=' + sec(elapsed).padStart(7) + '   ' + String(per).padStart(4) + 'ms   '
      + String(r.status).padEnd(5) + '  ' + cc);
    results.push({ elapsed, per, status: r.status, correct: cc });
    // 若已确认可用，继续测更早的点（这里从早到晚，所以遇到 200 也不停）
  }

  // ---------- 冷却是否被覆盖 ----------
  hr('③ 出题冷却是否被提交等待覆盖');
  const sinceMatch = Date.now() - tMatchOk;
  line('  距上次「出题成功」已过 ' + sec(sinceMatch) + '（冷却实测约 58s）');
  const tProbe = Date.now();
  const g2 = await exercise.getExam(jar, KP, 10, {});
  const dt = Date.now() - tProbe;
  line('  立即出题 → HTTP ' + g2.status + '  耗时 ' + sec(dt));
  if (g2.status === 200) {
    line('  ★ 冷却已被覆盖 → 下一轮**无需**再等 58s，每局可省约 58s');
  } else if (g2.status === 429) {
    line('  ✗ 仍被限流 → 冷却**独立于**提交等待，每局仍需额外等待');
  } else {
    line('  其它状态: ' + String(g2.text || '').slice(0, 100));
  }

  // ---------- 汇总 ----------
  hr('④ 结论');
  const ok = results.filter((r) => r.status === 200);
  const graded = results.filter((r) => r.status === 200 && Number(r.correct) > 0);
  if (ok.length) {
    line('  提交通过的最早时间: ' + sec(Math.min.apply(null, ok.map((r) => r.elapsed)))
      + '（' + Math.min.apply(null, ok.map((r) => r.per)) + 'ms/题）');
  }
  if (graded.length) {
    line('  **判对>0 的最早时间**: ' + sec(Math.min.apply(null, graded.map((r) => r.elapsed)))
      + '（' + Math.min.apply(null, graded.map((r) => r.per)) + 'ms/题）  ← 这个才是「上榜可用」的下限');
  } else {
    line('  注意：没有一次提交拿到 correctCnt>0 —— 需检查笔迹/答案。');
  }
  line('  当前 rank 系数 500ms/题 → ' + NQ + ' 题需 ' + (NQ * 0.5 + 0.5).toFixed(1) + 's');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });