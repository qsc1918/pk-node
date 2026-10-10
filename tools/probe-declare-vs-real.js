#!/usr/bin/env node
'use strict';
/**
 * 破解「提交等待 = 题数 × 200ms」这条线性规则 —— 看能不能绕开它。
 *
 * ## 为什么要查
 *   已实测（tools/calibrate-submit-min.js）：
 *     10 题 → 需 ≥ 2473ms（247ms/题）
 *     100 题 → 需 ≥ 20000ms（200ms/题）
 *     200 题 → 需更长
 *
 *   **这很奇怪**：若服务端是防「机器秒答」，它应该校验**单题作答时长**，
 *   而不是**总时长**。总时长与题数成正比，说明它在用
 *        实际间隔 ≥ 题数 × 系数
 *   这种形式。既如此，就存在**别的口径**可以试：
 *
 *     H1 实际间隔 ≥ Σ(每题 costTime)   —— 我已推翻（顶层 11s / Σ=25s 也 200）
 *     H2 实际间隔 ≥ 题数 × 固定系数     —— 当前观测
 *     H3 实际间隔 ≥ 顶层 costTime × k   —— 即"声明得越小，要求越低"
 *
 * ## 关键实验（把「声明值」与「实际间隔」解耦，做二维矩阵）
 *
 *   同一次出题（100 题），只改**顶层 costTime** 的声明：
 *
 *     实际间隔固定 8s（约 80ms/题，低于观测阈值）
 *     顶层声明依次: 8s / 20s / 60s / 200s / 2000s
 *
 *   · 若**声明越小越容易过** ⇒ H3 成立，那冲榜模式就该"少声明"
 *   · 若无论声明多少都 400 ⇒ 服务端只看真实间隔（H2），已到物理下限
 *
 *   （安全：每题 costTime 一律给 5ms。）
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC = Number(process.argv[2] || 18);
const KP = Number(process.argv[3] || 235001);
const NQ = Number(process.argv[4] || 100);
const REAL_GAP = Number(process.argv[5] || 8000);      // 固定实际间隔
const DECLARE = (process.argv[6] || '8000,20000,60000,200000,2000000').split(',').map(Number);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

function buildBody(exam, top) {
  const c = JSON.parse(JSON.stringify(exam));
  const qs = c.questions || [];
  for (const q of qs) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = String(a); q.status = 1; }
    q.costTime = 5;
  }
  c.costTime = top;
  c.correctCnt = qs.length;
  return c;
}

async function matchReal(jar, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const g = await exercise.getExam(jar, KP, NQ, {});
    const b = g.json || {};
    const id = b.idString == null ? null : String(b.idString);
    if (g.status === 200 && id && id !== '0') return { ok: true, exam: g.json };
    await sleep(300);
  }
  return { ok: false };
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);

  line('账号 ' + ACC + '  知识点 ' + KP + '  题数 ' + NQ);
  line('固定实际间隔 ' + REAL_GAP + 'ms（' + (REAL_GAP / NQ).toFixed(0) + 'ms/题，低于观测阈值）');
  line('顶层声明依次: ' + DECLARE.join(', ') + ' ms');

  hr('逐档实验（每档需重新出题）');
  const rows = [];
  for (const dec of DECLARE) {
    const m = await matchReal(jar, 180000);
    if (!m.ok) { line('  出题失败（拿不到真卷），跳过'); continue; }
    const idString = String(m.exam.idString);
    const t0 = Date.now();
    await sleep(REAL_GAP);
    const real = Date.now() - t0;
    const r = await exercise.submitExam(jar, idString, buildBody(m.exam, dec), {});
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    const corr = r.status === 200 ? ((r.json || {}).correctCnt) : null;
    line('  实际 ' + String(real).padStart(5) + 'ms  声明 ' + String(dec).padStart(8) + 'ms  → '
      + tag + (corr != null ? '  判对 ' + corr + '/' + NQ : '')
      + (r.status !== 200 ? '  ' + String(r.text || '').slice(0, 50).replace(/\s+/g, ' ') : ''));
    rows.push({ real: real, dec: dec, status: r.status });
  }

  hr('判定');
  const ok = rows.filter((x) => x.status === 200);
  const bad = rows.filter((x) => x.status !== 200);
  if (ok.length && bad.length) {
    const minDecOk = Math.min.apply(null, ok.map((x) => x.dec));
    const maxDecBad = Math.max.apply(null, bad.map((x) => x.dec));
    if (minDecOk < maxDecBad) {
      line('  ✅ **声明越小越容易过** ⇒ H3 成立（服务端校验「实际 ≥ 声明」）');
      line('     ⇒ 冲榜模式应把顶层 costTime 声明得**尽可能小**（如 = 实际间隔的下限目标）。');
    } else {
      line('  ⚠️ 通过的都是"声明大"的那组 ⇒ 反而是 H3 的反面，需要再看数据。');
    }
  } else if (ok.length) {
    line('  在 ' + REAL_GAP + 'ms（' + (REAL_GAP / NQ).toFixed(0) + 'ms/题）下**全部通过**');
    line('  ⇒ 该间隔已足够，阈值比观测的更低（需往下校准）。');
  } else {
    line('  全部失败 ⇒ 服务端确实只看真实间隔（H2）');
    line('  ⇒ ' + REAL_GAP + 'ms（' + (REAL_GAP / NQ).toFixed(0) + 'ms/题）低于物理下限。');
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });