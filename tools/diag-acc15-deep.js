#!/usr/bin/env node
'use strict';
/**
 * 逐层排查 15 号账号「出题 200 / 提交 401」的原因。
 *
 * ## 已排除
 *   · sign：10-08 样本 4/4 命中，签名链路正确
 *   · 路径：/exams/{id} 存在（POST 返回 405 而非 404）
 *   · 笔迹：已加密到真机同量级（670 字符）
 *
 * ## 待查
 *   1. cookie 是否过期（GET 类接口也要能过）
 *   2. 是「这个账号特殊」还是「所有账号都这样」
 *   3. 换个知识点（不用比大小）会不会不同
 */
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const ex = require(path.join(ROOT, 'src', 'exercise'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const ACC = Number(process.argv[2] || 15);

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC);
  const jar = jobs.jarOf(acc);
  console.log('账号 id=%s name=%s yfd_u=%s', acc.id, acc.name, acc.yfd_u);
  console.log('='.repeat(78));

  // 逐层探活：从最轻的接口开始
  const probes = [
    ['GET', '/leo-star/android/exercise/homepage', '练习首页'],
    ['GET', '/leo-star/android/exercise/rank/pre-fetch', '分数读数'],
    ['GET', '/leo-math/android/recommend/keypoint', '知识点'],
  ];
  for (const [m, p, label] of probes) {
    try {
      const url = ex.buildExerciseUrl(p);
      const r = await require(path.join(ROOT, 'src', 'http')).request({
        url, method: m, jar, headers: ex.exerciseHeaders(),
      });
      console.log('  %-14s %-46s HTTP %s  %s', label, p.slice(0, 46), r.status,
        String(r.text).slice(0, 70));
    } catch (e) {
      console.log('  %-14s 异常 %s', label, e.message);
    }
  }

  // 主域身份接口（判断登录态）
  console.log();
  console.log('身份接口（判断登录态）:');
  for (const [p, label] of [
    ['/leo-profile/android/user-infos/batchGet', '子账号信息'],
  ]) {
    try {
      const url = leo.buildUrl(p, {});
      const r = await require(path.join(ROOT, 'src', 'http')).request({
        url, method: 'GET', jar, headers: leo.mainDomainHeaders(),
      });
      console.log('  %-14s HTTP %s  %s', label, r.status, String(r.text).slice(0, 160));
    } catch (e) {
      console.log('  %-14s 异常 %s', label, e.message);
    }
  }

  // 出题 → 提交（换几个知识点试）
  console.log();
  console.log('出题 + 提交（换知识点试）:');
  const kps = [235001, 94, 93, 1];
  for (const kp of kps) {
    let g;
    try {
      g = await ex.getExam(jar, kp, 10, {});
    } catch (e) {
      console.log('  kp=%-7s 出题异常 %s', kp, e.message);
      continue;
    }
    if (g.status !== 200) {
      console.log('  kp=%-7s 出题 HTTP %s  %s', kp, g.status, String(g.text).slice(0, 80));
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const exam = g.json;
    const ans = ex.answerAll(exam);
    const s = await ex.submitExam(jar, exam.idString, ans, {});
    console.log('  kp=%-7s 出题 200 (%s, %d 题) → 提交 HTTP %s  %s',
      kp, exam.keypoint, exam.questionCnt, s.status, String(s.text).slice(0, 80));
    await new Promise((r) => setTimeout(r, 2000));
  }
})().catch((e) => { console.error('异常:', (e && e.stack) || e); process.exit(1); });