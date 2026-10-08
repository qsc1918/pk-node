#!/usr/bin/env node
'use strict';
/**
 * 试出「练习提交」能通的路径与请求体形态。
 *
 * 背景：真机日志里 `PUT /exams/v2/{id}` 7 次全 400，
 *       说明那不是可用样本。所以要把候选形态都试一遍。
 */
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const ex = require(path.join(ROOT, 'src', 'exercise'));
const { request } = require(path.join(ROOT, 'src', 'http'));

const ACC = Number(process.argv[2] || 15);

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC);
  if (!acc) { console.error('无账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);

  const g = await ex.getExam(jar, 235001, 10, {});
  console.log('出题: HTTP %s  examId=%s', g.status, g.json && g.json.idString);
  if (g.status !== 200) { console.log('body:', String(g.text).slice(0, 200)); return; }
  const exam = g.json;
  const ans = ex.answerAll(exam);

  // 候选形态
  const variants = [
    { name: 'PUT  /exams/{id}      含全字段',   method: 'PUT',  p: '/leo-math/android/exams/',    body: ans },
    { name: 'PUT  /exams/v2/{id}   含全字段',   method: 'PUT',  p: '/leo-math/android/exams/v2/', body: ans },
    { name: 'POST /exams/{id}      含全字段',   method: 'POST', p: '/leo-math/android/exams/',    body: ans },
    { name: 'PUT  /exams/{id}      只轻量体',   method: 'PUT',  p: '/leo-math/android/exams/',    body: {
        idString: exam.idString, correctCnt: ans.questions.length,
        costTime: ans.costTime, questions: ans.questions,
      } },
  ];

  for (const v of variants) {
    const url = ex.buildExerciseUrl(v.p + exam.idString);
    let r;
    try {
      r = await request({
        url, method: v.method, jar,
        body: Buffer.from(JSON.stringify(v.body), 'utf8'),
        headers: ex.exerciseHeaders({ 'Content-Type': 'application/json' }),
      });
    } catch (e) {
      console.log('%-34s → 异常 %s', v.name, e.message);
      continue;
    }
    console.log('%-34s → HTTP %s  %s', v.name, r.status, String(r.text).slice(0, 110));
    if (r.status === 200) {
      console.log();
      console.log('★★★ 命中！形态: %s', v.name);
      console.log('    响应: %s', String(r.text).slice(0, 400));
      break;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });