#!/usr/bin/env node
'use strict';
/**
 * 验证：服务端的「秒答」校验到底比对什么。
 *
 * ## 假设
 *   服务端校验 `Σ(每题 costTime) ≤ 提交时刻 − 出题时刻`。
 *   若成立 ⇒ 把每题 costTime 声明小一点，就不必干等 90s。
 *
 * ## 依据（此前实测）
 *   练习 10 题 × 900ms = 9000ms：
 *     出题后 ~2s 提交 → 400
 *     出题后 ~15s 提交 → 200
 *   恰好卡在 9s 附近，与「Σper-question ≤ elapsed」一致。
 *
 * ## 本次实验（同一份 exam，只改每题的 costTime）
 *   A 每题 costTime=100ms（Σ=1s）→ 出题后 ~2.5s 提交 → 预期 200（若假设成立）
 *   B 每题 costTime=3000ms（Σ=30s）→ 出题后 ~3s 提交 → 预期 400（复现旧行为）
 *
 * ⚠️ 只跑 2 组，且都改每题（不动顶层），避免多变量。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

/** 只改每题的 costTime，其余完全保留服务端给的原样。 */
function withPerQ(exam, perMs) {
  const clone = JSON.parse(JSON.stringify(exam));
  for (const q of clone.questions || []) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) {
      q.userAnswer = a;
      q.status = 1;
    }
    q.costTime = perMs;
  }
  return clone;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 id=' + acc.id + '  yfd_u=' + acc.yfd_u);

  hr('出题（带 429 重试）');
  let g = null;
  for (let i = 0; i < 10; i++) {
    g = await exercise.getExam(jar, KP, 5, {});
    if (g.status === 200) break;
    if (g.status !== 429) { line('  失败: ' + String(g.text).slice(0, 120)); process.exit(0); }
    line('  429，等 10s（第 ' + (i + 1) + ' 次）');
    await sleep(10000);
  }
  if (!g || g.status !== 200) { line('  一直频控，稍后再试'); process.exit(0); }
  const exam = g.json;
  const examId = exam.idString;
  const matchOkAt = Date.now();
  line('  examId = ' + examId + '  题数 = ' + (exam.questions || []).length);

  const cases = [
    { name: 'A 每题 100ms（Σ=0.5s）', per: 100 },
    { name: 'B 每题 3000ms（Σ=15s）', per: 3000 },
  ];

  hr('逐组提交');
  for (const c of cases) {
    const body = withPerQ(exam, c.per);
    const elapsed = Date.now() - matchOkAt;
    line('');
    line('  ' + c.name + '   当前已过 ' + (elapsed / 1000).toFixed(1) + 's');
    const r = await exercise.submitExam(jar, examId, body, {});
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('    → ' + tag + (r.status === 200 ? '   服务端 correctCnt=' + ((r.json || {}).correctCnt) : ''));
    if (r.status !== 200) line('      ' + String(r.text || '').slice(0, 120).replace(/\s+/g, ' '));
    await sleep(3000);
  }

  hr('判定');
  line('  A=200 → 校验只看「Σ每题 costTime ≤ 实际间隔」，声明小就不必长等。');
  line('  A=400 且 B=400 → 服务端另有固定下限（与声明值无关），再另找。');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });