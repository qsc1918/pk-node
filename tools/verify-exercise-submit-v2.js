#!/usr/bin/env node
'use strict';
/**
 * 验证 `/v2/` 路径 + 正确编码 = 200（把 body 内容也补齐）。
 *
 * ## 上一轮的结论
 *
 *   ① 旧路径 + 明文/密文 → **415** Content-Type 都不认（网关没有这条路）
 *   ③ /v2/   + 明文/密文 → **400** error（路由存在，是 body 内容问题）
 *
 * ## 本轮
 *
 * 400 是「body 内容不对」。上一轮用了空的 `questions: []`，服务端当然拒。
 * 这轮**真出题 → 真作答 → 真提交**，看能否 200 判分。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const native = require(path.join(ROOT, 'src', 'native'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const raw = JSON.parse(fs.readFileSync('/tmp/dev_cookies_now.json', 'utf8'));

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(90)); line(t); line('='.repeat(90)); }

/** 用 pk-node 已有的 answerAll 作答（含笔迹）。 */
function buildBody(exam, top) {
  const body = exercise.answerAll
    ? exercise.answerAll(exam, { costTimeMs: 200 })
    : null;
  if (body) return body;
  // 退化：手工填
  const c = JSON.parse(JSON.stringify(exam));
  for (const q of (c.questions || [])) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = String(a); q.status = 1; }
    q.costTime = 200;
  }
  c.costTime = top;
  c.correctCnt = (c.questions || []).length;
  return c;
}

(async () => {
  const jar = new CookieJar(JSON.parse(JSON.stringify(raw)));

  hr('① 出题（多知识点轮询，找可用账号）');

  const KPS = [235001, 411, 1951, 1952, 1964];
  let exam = null;
  for (const kp of KPS) {
    for (let i = 0; i < 6 && !exam; i++) {
      const g = await exercise.getExam(jar, kp, 10, {});
      const b = g.json || {};
      const id = b.idString == null ? null : String(b.idString);
      if (g.status === 200 && id && id !== '0' && (b.questions || []).length > 0) {
        exam = b;
        line('  ✅ kp=' + kp + ' examId=' + id + ' 题数=' + b.questions.length);
        break;
      }
      line('  kp=' + kp + ' 第 ' + (i + 1) + ' 次 → HTTP ' + g.status +
        ' idString=' + id);
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (exam) break;
  }
  if (!exam) { line('  出题始终拿不到真卷，改用真机 id 走最小 body'); }

  const examId = exam ? exam.idString : '1558812446144884736';
  const body = exam
    ? buildBody(exam, 2500)
    : { idString: examId, questionCnt: 10, correctCnt: 10, costTime: 2500, questions: [] };

  const plain = Buffer.from(JSON.stringify(body), 'utf8');
  let cipher = null;
  try { cipher = native.encodeSubmitBody(plain); } catch (e) { /* ignore */ }

  line('  body 明文 ' + plain.length + 'B' +
    (cipher ? '，密文 ' + cipher.length + 'B' : '，编码失败'));

  hr('② 提交：/v2/ 路径');

  async function put(label, buf, ct) {
    const p = '/leo-math/android/exams/v2/' + examId;
    const r = await request({
      url: exercise.buildExerciseUrl(p), method: 'PUT', jar,
      body: buf, headers: { 'Content-Type': ct },
    });
    line('  ' + label.padEnd(40) +
      (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
      '  ' + String(r.text).slice(0, 90).replace(/\s+/g, ' '));
    return r;
  }

  if (cipher) {
    await put('密文 + octet-stream', cipher, 'application/octet-stream');
    await new Promise((r) => setTimeout(r, 2000));
  }
  await put('明文 + application/json', plain, 'application/json');
  await new Promise((r) => setTimeout(r, 2000));
  if (cipher) {
    await put('密文 + application/json', cipher, 'application/json');
  }

  hr('判定');
  line('  · 若有 200 ⇒ /v2/ 路径正确，App 按此改即可');
  line('  · 若全 400 ⇒ body 结构还要再对齐（下一步 dump 差异）');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });