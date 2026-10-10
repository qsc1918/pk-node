#!/usr/bin/env node
'use strict';
/**
 * 决定性实验：上榜所需的「0.5s/题」到底体现在**声明值**还是**实际间隔**？
 *
 * ## 为什么要问这个
 *   用户实测给了两个系数：
 *     · 0.2s/题 → 够过提交
 *     · 0.5s/题 → 上榜
 *   而我此前测出「服务端只卡**实际间隔**，声明值无关」
 *   （tools/probe-declared-vs-elapsed.js：声明 1ms + 真等 5.3s → 200）。
 *
 *   若这两条同时成立，就能推出一条关键结论：
 *     **声明 0.5s/题（够上榜）+ 只真等 0.2s/题（够提交）= 又快又上榜。**
 *
 *   反之若服务端要求 `实际间隔 ≥ 声明总耗时`，那就必须真等 0.5s/题，
 *   200 题必然 100s —— 只能靠「少开题」解决。
 *
 * ## 当前默认值的问题（用户看到的 100s）
 *      rank 模式 500ms/题 × 默认 200 题 + 500ms 余量 = 100.5s
 *   两个默认值分别调过，叠起来就变成不可接受的长度。
 *
 * ## 本实验（一次出题，同一 exam 多次提交，间隔递增）
 *   题数取 50（0.2s/题 → 10s；0.5s/题 → 25s，规模适中）
 *
 *   A  间隔 ~10s，声明 0.2s/题（Σ=10s）   → 基线，预期 200
 *   B  间隔 ~11s，声明 0.5s/题（Σ=25s）   → **关键**：间隔 < 声明也只能过吗？
 *   C  间隔 ~27s，声明 0.5s/题（Σ=25s）   → 上榜式基线，预期 200
 *
 * ⚠️ 提交必须按间隔递增顺序（已过时间只会增长），否则无法归因。
 * ⚠️ 等待基准用「出题**成功**」时刻（matchOkAt），不是出题开始时刻。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const NQ = Number(process.argv[4] || 50);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

/** 组题：声明每题 perMs；顶层 costTime = perMs × 题数。 */
function buildBody(exam, perMs) {
  const c = JSON.parse(JSON.stringify(exam));
  const qs = c.questions || [];
  for (const q of qs) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = String(a); q.status = 1; }
    q.costTime = perMs;
  }
  c.costTime = perMs * qs.length;
  c.correctCnt = qs.length;
  return c;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 ' + acc.id + '  知识点 ' + KP + '  题数 ' + NQ);

  hr('出题');
  let g = null;
  for (let i = 0; i < 30; i++) {
    g = await exercise.getExam(jar, KP, NQ, {});
    if (g.status === 200) break;
    if (g.status !== 429) { line('  出题失败 ' + g.status + ': ' + String(g.text).slice(0, 100)); process.exit(0); }
    await sleep(3000);
  }
  if (!g || g.status !== 200) { line('  出题始终被限流'); process.exit(0); }

  const exam = g.json;
  const n = (exam.questions || []).length;
  const matchOkAt = Date.now();          // ★ 基准 = 出题成功时刻
  line('  examId=' + exam.idString + '  题数=' + n);
  line('  0.2s/题 → 需 ' + (n * 200 / 1000).toFixed(1) + 's   0.5s/题 → 需 ' + (n * 500 / 1000).toFixed(1) + 's');

  const cases = [
    { name: 'A 间隔10s 声明0.2s/题', waitMs: 10200, per: 200 },
    { name: 'B 间隔11s 声明0.5s/题', waitMs: 11000, per: 500 },
    { name: 'C 间隔27s 声明0.5s/题', waitMs: 27000, per: 500 },
  ];

  hr('逐组提交（按间隔递增）');
  for (const c of cases) {
    const need = c.waitMs - (Date.now() - matchOkAt);
    if (need > 0) await sleep(need);
    const elapsed = Date.now() - matchOkAt;
    const body = buildBody(exam, c.per);
    const r = await exercise.submitExam(jar, exam.idString, body, {});
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('  ' + c.name.padEnd(24)
      + ' 实际间隔 ' + String((elapsed / 1000).toFixed(1)).padStart(5) + 's'
      + '  声明Σ ' + String((c.per * n / 1000).toFixed(1)).padStart(5) + 's'
      + '  → ' + tag
      + (r.status === 200 ? '  判对 ' + ((r.json || {}).correctCnt) + '/' + n : ''));
    if (r.status !== 200) {
      line('       ' + String(r.text || '').slice(0, 110).replace(/\s+/g, ' '));
    }
    await sleep(800);
  }

  hr('判定');
  line('  B 若 ✅ → 服务端**不校验**「间隔 ≥ 声明」；');
  line('       则「上榜」可只靠声明值达成，实际等待可压到 0.2s/题（速度大幅提升）。');
  line('  B 若 ❌ → 声明必须 ≤ 实际间隔，上榜仍需真等 0.5s/题；');
  line('       200 题即 100s 不可免，只能靠「少开题」来缩短。');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });