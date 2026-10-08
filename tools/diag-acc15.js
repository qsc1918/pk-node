#!/usr/bin/env node
'use strict';
/**
 * 深挖「账号 15（id=15, yfd_u=1065256518）」的失败点。
 *
 * ## 已知
 *   · 其它账号在出题就 400 "已封禁"
 *   · 只有 id=15 **出题成功**，走到 submit 才 401
 *   → 说明 15 号是活账号，问题在**提交环节**
 *
 * ## 要查清
 *   1. 出题返回的题目里有没有 answer（抄答案依赖它）
 *   2. answerAll 生成的笔迹是否合法
 *   3. submit 的 401 是「签名错」还是「登录态过期」
 *   4. 拿服务端原文对比
 */
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));
const nativeLib = require(path.join(ROOT, 'src', 'native'));

const ACC_ID = Number(process.argv[2] || 15);

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { console.error('找不到账号 ' + ACC_ID); process.exit(1); }
  console.log('账号: id=%s name=%s yfd_u=%s', acc.id, acc.name, acc.yfd_u);
  console.log('='.repeat(78));

  const jar = jobs.jarOf(acc);

  // 1) 读分数
  console.log('[1] 读分数');
  try {
    const sc = await exercise.readScore(jar);
    console.log('    curWeekScore =', sc, sc === null ? '（读不到 → 可能 cookie 失效）' : '');
  } catch (e) { console.log('    异常:', e.message); }

  // 2) 出题（拿到 exam 细节）
  console.log();
  console.log('[2] 出题');
  const kp = 235001, limit = 10;
  const g = await exercise.getExam(jar, kp, limit, {});
  console.log('    HTTP', g.status);
  if (g.status !== 200) {
    console.log('    body:', String(g.text).slice(0, 300));
    process.exit(0);
  }
  const exam = g.json;
  console.log('    examId =', exam.idString, ' keypoint =', exam.keypoint,
              ' 题数 =', exam.questionCnt);

  // 抽查题目结构：有没有 answer / 能不能出笔迹
  const qs = exam.questions || exam.examVO && exam.examVO.questions || [];
  console.log('    questions 数 =', qs.length);
  if (qs.length) {
    const q0 = qs[0];
    console.log('    第 1 题字段:', Object.keys(q0).join(', '));
    console.log('    第 1 题:', JSON.stringify({
      content: q0.content, answer: q0.answer, ruleType: q0.ruleType,
      questionId: q0.questionId,
    }).slice(0, 200));
  }

  // 3) 生成答案（不提交）
  console.log();
  console.log('[3] 生成答案 + 笔迹');
  const answered = exercise.answerAll(exam, undefined);
  console.log('    判对（本地）:', answered.correctCnt, '/', answered.questionCnt);
  const aq = (answered.questions || [])[0];
  if (aq) {
    console.log('    第 1 题提交字段:', Object.keys(aq).join(', '));
    console.log('    userAnswer =', JSON.stringify(aq.userAnswer));
    console.log('    script 长度 =', String(aq.script || '').length);
  }

  // 4) 提交（关键）
  console.log();
  console.log('[4] 提交');
  const s = await exercise.submitExam(jar, exam.idString, answered, {});
  console.log('    HTTP', s.status);
  console.log('    body:', String(s.text).slice(0, 400));

  // 5) 如果 401，检查签名
  if (s.status === 401) {
    console.log();
    console.log('[5] 401 排查：算一下 sign');
    const p = '/leo-math/android/exams/' + exam.idString;
    try {
      const sign = nativeLib.calcSign(p, { variant: 'exercise' });
      console.log('    path =', p);
      console.log('    sign =', sign);
    } catch (e) {
      console.log('    算 sign 异常:', e.message);
    }
    console.log();
    console.log('    → 若 sign 正常（32 位 hex），401 更可能是「提交体格式/登录态」问题，');
    console.log('      而不是签名问题（签名错通常会 417 而不是 401）。');
  }
})().catch((e) => { console.error('异常:', (e && e.stack) || e); process.exit(1); });