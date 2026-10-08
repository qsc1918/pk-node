#!/usr/bin/env node
'use strict';
/**
 * 验证练习提交修复：`submitExam` 是否从 401/400 变成 200。
 *
 * 修复内容（两处，都有真机逐字证据）：
 *   ① 路径：`/exams/{id}` → `/exams/v2/{id}`      （修 401）
 *   ② body：明文 JSON → encodeSubmitBody 密文     （修 400）
 *      + Content-Type: application/json → application/octet-stream
 *
 * ## 判据
 *   · 200 → 提交成功（服务端会返回批改结果）
 *   · 400 → 路径对了但 body 仍不合规
 *   · 401 → 路径仍不对
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));
const nativeLib = require(path.join(ROOT, 'src', 'native.js'));
const { config, PK } = require(path.join(ROOT, 'src', 'config'));
const leo = require(path.join(ROOT, 'src', 'leo'));
const { request } = require(path.join(ROOT, 'src', 'http'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 235001);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(92)); line(t); line('='.repeat(92)); }

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号 ' + ACC_ID); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 id=' + acc.id + '  yfd_u=' + acc.yfd_u);

  // ---- ① 出题 ----
  hr('① 出题');
  const g = await exercise.getExam(jar, KP, 10, {});
  line('  HTTP ' + g.status);
  if (g.status !== 200) {
    line('  body: ' + String(g.text || '').slice(0, 200));
    line('  出题失败（多为 429 频控），稍后重试');
    process.exit(0);
  }
  const exam = g.json;
  const examId = exam.idString || exam.examId || exam.id;
  line('  examId = ' + examId + '  题数 = ' + ((exam.questions || []).length));

  // 填答案（模拟真人作答：抄题面 answer + 状态 + 耗时）
  const qs = exam.questions || [];
  let filled = 0;
  for (const q of qs) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) {
      q.userAnswer = a;
      q.status = 1;
      q.costTime = Math.max(5, Number(q.costTime) || 900);
      filled++;
    }
  }
  line('  已填答案 = ' + filled + '/' + qs.length);

  await sleep(2500);

  // ---- ② 编码自检 ----
  hr('② 编码自检（与真机 body 同链路）');
  try {
    const plain = Buffer.from(JSON.stringify(exam), 'utf8');
    const cipher = nativeLib.encodeSubmitBody(plain);
    line('  明文 ' + plain.length + 'B → 密文 ' + cipher.length + 'B');
    line('  密文前 32 字节 hex: ' + cipher.slice(0, 32).toString('hex'));
    line('  ✅ 编码可用（与 attend 同一条链路）');
  } catch (e) {
    line('  ❌ 编码失败: ' + e.message);
  }

  await sleep(1500);

  // ---- ③ 走修复后的 submitExam ----
  hr('③ submitExam（修复后：/v2/ + 密文 + octet-stream）');
  const sub = await exercise.submitExam(jar, examId, exam, {});
  line('  → HTTP ' + sub.status);
  line('  body: ' + String(sub.text || '').slice(0, 400).replace(/\s+/g, ' '));

  if (sub.status === 200) {
    line('');
    line('  ✅✅ 提交成功！');
    const j = sub.json || {};
    line('     correctCnt = ' + j.correctCnt + ' / questionCnt = ' + j.questionCnt);
    line('     costTime   = ' + j.costTime);
  } else if (sub.status === 400) {
    line('');
    line('  ⚠️ 路径已对（不再是 401），但 body 仍被拒。');
  } else if (sub.status === 401) {
    line('');
    line('  ❌ 仍然 401 —— 路径可能还有问题。');
  }

  line('');
  line('='.repeat(92));
  line('对比表（供归档）');
  line('='.repeat(92));
  line('  修复前: PUT /exams/{id}       + 明文 JSON  → 401');
  line('  改路径: PUT /exams/v2/{id}    + 明文 JSON  → 400');
  line('  改 body: PUT /exams/v2/{id}   + 密文      → ' + sub.status);
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });