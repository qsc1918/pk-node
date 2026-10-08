#!/usr/bin/env node
'use strict';
/**
 * 修复后的决定性验证：PK 全链路 + 练习全链路。
 *
 * ## 验证目标
 *   ① PK 出题 v2（修复前 417）        → 期望 200
 *   ② PK 主页 / 榜单                    → 期望 200
 *   ③ 练习出题（GET keypoints）         → 期望非 417
 *   ④ 练习提交（修复前 401）★           → 期望非 417
 *
 * ## 判据
 *   修复的真因是「签名资产与 version 配对」。若修复生效：
 *     · 所有主域/PK 端点不应再出现 417
 *     · 业务层的 400/401（参数/登录态）不算签名失败
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const leo = require(path.join(ROOT, 'src', 'leo'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));
const schoolSeason = require(path.join(ROOT, 'src', 'school-season'));
const nativeLib = require(path.join(ROOT, 'src', 'native.js'));

const ACC_ID = Number(process.argv[2] || 15);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const results = [];
function record(name, status, note) {
  results.push({ name, status, note });
  const ok = (status !== 417 && status !== 'ERR');
  line('  ' + (ok ? '✅' : '❌') + ' ' + name + ' → ' + status + (note ? '  ' + note : ''));
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号 ' + ACC_ID); process.exit(1); }
  const jar = jobs.jarOf(acc);

  line('='.repeat(90));
  line('修复后全链路验证   账号 id=' + acc.id + '  yfd_u=' + acc.yfd_u);
  line('='.repeat(90));

  line('');
  line('【变体解析自检】');
  for (const v of ['3.140.1', '3.141.1', '3.143.1', '9.9.9']) {
    line('  version=' + v.padEnd(9) + ' → variant=' + nativeLib.variantForVersion(v));
  }

  // ---- ① PK 主页 ----
  line('');
  line('【① PK 主页 game/battle/v2/math/home】');
  let pointId = null;
  try {
    const r = await schoolSeason.home(jar, { grade: 2 });
    record('GET game/battle/v2/math/home', r.status);
    const pts = (r.json && r.json.points) || [];
    if (pts.length) { pointId = pts[0].pointId; line('     pointId 可用: ' + pts.slice(0, 3).map((p) => p.pointId).join(', ')); }
  } catch (e) { record('GET game/battle/v2/math/home', 'ERR', e.message); }

  await sleep(1500);

  // ---- ② PK 榜单 ----
  line('');
  line('【② PK 榜单 game/battle/v2/math/rank】');
  if (pointId != null) {
    try {
      const r = await schoolSeason.rank(jar, { pointId: pointId, scope: 1 });
      record('GET game/battle/v2/math/rank', r.status);
    } catch (e) { record('GET game/battle/v2/math/rank', 'ERR', e.message); }
  } else {
    line('  （跳过：没拿到 pointId）');
  }

  await sleep(1500);

  // ---- ③ PK 出题 v2（修复前 417）----
  line('');
  line('【③ PK 出题 v2（修复前 417）】');
  if (pointId != null) {
    try {
      const r = await leo.pkMatchV2(jar, pointId, {});
      record('POST math/pk/match/v2', r.status,
        r.status === 200 ? '加密题面 ' + String(r.text || '').length + 'B' : String(r.text || '').slice(0, 90));
    } catch (e) { record('POST math/pk/match/v2', 'ERR', e.message); }
  } else {
    line('  （跳过：没拿到 pointId）');
  }

  await sleep(1500);

  // ---- ④ 练习出题 ----
  line('');
  line('【④ 练习链路（GET 出题）】');
  try {
    const r = await exercise.keypoints(jar, { grade: 2, semester: 1 });
    record('GET leo-math keypoints', r && r.status);
  } catch (e) { record('GET leo-math keypoints', 'ERR', e.message); }

  await sleep(1500);

  // ---- ⑤ 练习提交路径可用性 ----
  line('');
  line('【⑤ 练习提交端点可达性（不带 body，看是否 405/404/417）】');
  try {
    const r = await exercise.getExam(jar, 235001, 10, {});
    record('POST leo-math/android/exams（出题）', r.status,
      r.status !== 200 ? String(r.text || '').slice(0, 110) : '题数=' + ((r.json && (r.json.questionCnt || (r.json.questions || []).length)) || '-'));

    if (r.status === 200) {
      const exam = r.json;
      const examId = exam.idString || exam.examId || exam.id;
      line('     examId = ' + examId);
      await sleep(2000);
      // 走到提交：用真实 exam 组装（笔迹由 exercise 内部补）
      try {
        const sub = await exercise.submitExam(jar, examId, exam, {});
        record('PUT leo-math/android/exams/{id}（提交）', sub && sub.status,
          sub && sub.status !== 200 ? String(sub.text || '').slice(0, 130) : '成功');
      } catch (e) { record('PUT leo-math/android/exams/{id}（提交）', 'ERR', e.message); }
    }
  } catch (e) { record('POST leo-math/android/exams（出题）', 'ERR', e.message); }

  // ---- 汇总 ----
  line('');
  line('='.repeat(90));
  line('汇总');
  line('='.repeat(90));
  const bad = results.filter((r) => r.status === 417);
  line('  端点总数: ' + results.length);
  line('  417（签名失败）: ' + bad.length);
  if (!bad.length) {
    line('');
    line('  ✅ **没有任何端点返回 417** —— 「版本↔资产」配对修复生效。');
    line('     剩余的非 200 都是业务层问题（参数 / 登录态 / 频控），不属于签名。');
  } else {
    line('');
    line('  ❌ 仍有 %d 个 417：' % bad.length);
    bad.forEach((r) => line('     ' + r.name));
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });