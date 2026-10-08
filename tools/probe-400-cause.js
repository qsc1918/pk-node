#!/usr/bin/env node
'use strict';
/**
 * 精确验证：400 是否由**顶层 `correctCnt` / `costTime`（客户端自报成绩）**引起。
 *
 * ## 对照事实（已实测）
 *   · verify-submit-fixed.js：只改每题 userAnswer/status/costTime，
 *     **不动顶层 correctCnt/costTime** → HTTP 200 ✅
 *   · answerAll / probe-script-format：额外填了顶层
 *     `correctCnt = 题数`、`costTime = 每题耗时×题数` → HTTP 400 ❌
 *
 *   两者其余部分一致（10 个 QuestionVO 字段、密文 body、/v2/ 路径、
 *   octet-stream）。所以嫌疑锁定在这两个顶层字段。
 *
 * ## 设计与上次的差别（重要）
 *   上次每形态都重建 questions 数组；这次**只改一个变量**，
 *   其余保持「已证实能 200」的写法，避免多变量混淆。
 *
 * ## 只跑 3 组（429 频控很紧，必须省着用）
 *   A 不动 correctCnt/costTime      → 预期 200（复核基线）
 *   B 填 correctCnt/costTime        → 预期 400（复现）
 *   C 再次不动                       → 与 A 对照，排除「一局的第 2 次提交必然失败」
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 235001);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(90)); line(t); line('='.repeat(90)); }

/** 按「已证实 200」的写法作答：只改每题，不动顶层。 */
function answerLike200(exam) {
  const clone = JSON.parse(JSON.stringify(exam));
  for (const q of clone.questions || []) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) {
      q.userAnswer = a;
      q.status = 1;
      q.costTime = Math.max(5, Number(q.costTime) || 900);
    }
  }
  return clone;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 id=' + acc.id + '  yfd_u=' + acc.yfd_u);

  hr('出题');
  let g = null;
  for (let i = 0; i < 8; i++) {
    g = await exercise.getExam(jar, KP, 10, {});
    if (g.status === 200) break;
    if (g.status !== 429) { line('  非频控失败: ' + String(g.text).slice(0, 120)); process.exit(0); }
    line('  429 频控，等 12s（第 ' + (i + 1) + '/8 次）');
    await sleep(12000);
  }
  if (!g || g.status !== 200) { line('  出题始终被限流，稍后再试'); process.exit(0); }
  const exam = g.json;
  line('  examId = ' + exam.idString + '  题数 = ' + (exam.questions || []).length);
  line('  原始顶层: correctCnt=' + exam.correctCnt + ' costTime=' + exam.costTime);

  const cases = [
    { name: 'A 不动顶层（基线）', mutate: (b) => b },
    { name: 'B 填顶层 correctCnt/costTime', mutate: (b) => {
      b.correctCnt = (b.questions || []).length;
      b.costTime = 900 * (b.questions || []).length;
      return b;
    } },
    { name: 'C 再不动（对照）', mutate: (b) => b },
  ];

  hr('逐组提交');
  for (const c of cases) {
    const body = c.mutate(answerLike200(exam));
    const r = await exercise.submitExam(jar, exam.idString, body, {});
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('  ' + c.name.padEnd(28) + ' → ' + tag
      + (r.status === 200 ? '   correctCnt=' + ((r.json || {}).correctCnt)
        + '  服务端 costTime=' + ((r.json || {}).costTime) : ''));
    if (r.status !== 200) {
      line('      body: ' + String(r.text || '').slice(0, 130).replace(/\s+/g, ' '));
    }
    await sleep(5000);
  }

  hr('判定');
  line('  若 A/C 为 200 而 B 为 400 → 确认「顶层成绩字段不可自报」。');
  line('  若 A 也是 400 → 说明上上次的 200 是偶然（或与 exam 相关），需换角度。');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });