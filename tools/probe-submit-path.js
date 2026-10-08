#!/usr/bin/env node
'use strict';
/**
 * 决定性双路径对照：练习提交的 401 是不是「少了 /v2/」。
 *
 * ## 依据
 *   真机原生日志（auto_oral-2026-10-01.log）实测 7 次提交，**全部**是：
 *
 *       PUT /leo-math/android/exams/v2/{id}
 *
 *   而从没出现过 `/leo-math/android/exams/{id}`（不带 v2）。
 *
 *   但 pk-node 的 `submitExam()` 走的恰恰是**不带 v2** 的那条 → 401。
 *
 * ## 本次实验
 *   出一次题，拿同一个 exam 对象，向**两个路径**各发一次提交，
 *   只改路径、body 完全相同 → 谁 400（说明路由存在且鉴权通过）就是谁对。
 *
 *   · 400 = 路由存在、鉴权通过，只是 body 内容不合规
 *   · 401 = 未认证 / 路由不存在被网关拦
 *   · 405 = 方法不允许（路由存在但方法错）
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));
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

  // ---- 出题 ----
  hr('① 出题（POST /leo-math/android/exams）');
  const g = await exercise.getExam(jar, KP, 10, {});
  line('  HTTP ' + g.status);
  if (g.status !== 200) {
    line('  body: ' + String(g.text || '').slice(0, 260));
    line('  出题失败 → 无法继续（多为 429 频控，稍后重试）');
    process.exit(0);
  }
  const exam = g.json;
  const examId = exam.idString || exam.examId || exam.id;
  line('  examId = ' + examId);
  line('  题数 = ' + ((exam.questions || []).length));
  line('  keypointId = ' + exam.keypointId);

  // 填答案（抄题面自带的 answer）。真机的做法：userAnswer + status + costTime + script。
  const qs = exam.questions || [];
  for (const q of qs) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) {
      q.userAnswer = a;
      q.status = 1;
      q.costTime = Math.max(5, Number(q.costTime) || 800);
    }
  }
  line('  已填答案的题数 = ' + qs.filter((q) => q.userAnswer != null).length);

  await sleep(2500);

  // ---- 双路径对照 ----
  const variants = [
    { label: '不带 v2（现代码）', path: '/leo-math/android/exams/' + examId },
    { label: '带 v2（真机实测）', path: '/leo-math/android/exams/v2/' + examId },
  ];

  hr('② 双路径对照（同一份 body，仅路径不同）');
  for (const v of variants) {
    let url;
    try {
      url = exercise.__testBuildUrl ? exercise.__testBuildUrl(v.path) : null;
    } catch (e) { /* ignore */ }

    // 用模块内的 buildExerciseUrl 需要导出；没导出就手工组（与它同逻辑）
    if (!url) {
      const { config, PK } = require(path.join(ROOT, 'src', 'config'));
      const nativeLib = require(path.join(ROOT, 'src', 'native'));
      const q = [
        ['_productId', '611'],
        ['platform', PK.commonQuery.platform],
        ['version', PK.commonQuery.version],
        ['vendor', PK.commonQuery.vendor],
        ['av', PK.commonQuery.av],
        ['deviceCategory', PK.commonQuery.deviceCategory],
        ['webviewVersion', PK.commonQuery.webviewVersion],
        ['whRatio', PK.commonQuery.whRatio],
        ['isBackground', '0'],
      ];
      const sign = nativeLib.calcSign(v.path, { version: PK.commonQuery.version });
      if (sign) q.push(['sign', sign]);
      url = config.leoBase + v.path + '?' + q.map(([k, x]) => k + '=' + encodeURIComponent(x)).join('&');
    }

    line('');
    line('  --- ' + v.label + ' ---');
    line('  ' + url.slice(0, 250));
    try {
      const r = await request({
        url, method: 'PUT', jar,
        body: Buffer.from(JSON.stringify(exam), 'utf8'),
        headers: exercise.exerciseHeaders
          ? exercise.exerciseHeaders({ 'Content-Type': 'application/json' })
          : { 'Content-Type': 'application/json' },
        timeoutMs: 25000,
      });
      const blk = (r.headers && (r.headers['x-block-by'] || r.headers['X-Block-By'])) || '-';
      line('  → HTTP ' + r.status + '   x-block-by=' + blk);
      line('    body: ' + String(r.text || '').slice(0, 260).replace(/\s+/g, ' '));
    } catch (e) {
      line('  → 异常: ' + e.message);
    }
    await sleep(3000);
  }

  hr('判定');
  line('  · 谁返回 400/200（而非 401）→ 谁就是正确路径。');
  line('  · 若带 v2 返回 400，说明路径已对，剩下的是 body 结构问题。');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });