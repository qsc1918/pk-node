#!/usr/bin/env node
'use strict';
/**
 * 复现 App 的练习提交 401 —— 验证 pk-node 的「必须 /v2/」结论。
 *
 * ## 真机现状（2026-10-11 12:03/12:04）
 *
 *     POST /leo-math/android/exams                      → ✅ 200（出题）
 *     PUT  /leo-math/android/exams/1558812119203082240  → ❌ 401   ← App 走这条
 *     （无 x-block-by 头 —— 不是 solar-encoder / leo-auth 那两层）
 *
 * ## pk-node 的对照实验结论（2026-10-08，src/exercise.js:235）
 *
 *     同一份 body、仅路径不同：
 *       PUT /leo-math/android/exams/{id}     → 401（网关不认这条路）
 *       PUT /leo-math/android/exams/v2/{id}  → 400（路由存在、鉴权通过）
 *     真机原生日志里的 7 次提交**全部**是带 /v2/ 的。
 *
 * 且 body 必须**编码**（gzip→keystream XOR 密文），发明文 → 400 {"message":"error"}。
 *
 * ## 本实验
 *
 * 四组对照（用真机会话 cookie）：
 *   ① 旧路径 + 明文 body
 *   ② 旧路径 + 密文 body
 *   ③ /v2/ 路径 + 明文 body
 *   ④ /v2/ 路径 + 密文 body   ← 应当由「400 内容不对」证明路径+编码都对
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

const KP = 235001;
const NQ = 10;

/** 组一个最小可提交体（全对、含 costTime）。 */
function minimalBody(exam) {
  const c = JSON.parse(JSON.stringify(exam));
  for (const q of (c.questions || [])) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = String(a); q.status = 1; }
    q.costTime = 200;
  }
  c.costTime = 3000;
  c.correctCnt = (c.questions || []).length;
  return c;
}

async function put(label, examId, bodyBuf, useV2) {
  const jar = new CookieJar(JSON.parse(JSON.stringify(raw)));
  const p = (useV2 ? '/leo-math/android/exams/v2/' : '/leo-math/android/exams/') + examId;
  const url = exercise.buildExerciseUrl
    ? exercise.buildExerciseUrl(p)
    : null;
  if (!url) { line('  buildExerciseUrl 未导出，跳过'); return; }

  try {
    const r = await request({
      url, method: 'PUT', jar,
      body: bodyBuf,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    line('  ' + label.padEnd(44) +
      (r.status === 200 ? '✅ 200' : '❌ ' + r.status) +
      (r.headers['x-block-by'] ? '  block-by=' + r.headers['x-block-by'] : '') +
      '  ' + String(r.text).slice(0, 60).replace(/\s+/g, ' '));
    return r.status;
  } catch (e) {
    line('  ' + label.padEnd(44) + '异常 ' + e.message);
    return -1;
  }
}

(async () => {
  hr('① 用真机日志里的真实 examId 做对照');

  // 出题接口在 pk-node 侧当前拿不到真卷（可能撞冷却），
  // 直接用真机日志里那条 401 的 examId —— 它一定是「出题成功过的真实卷」。
  const examId = process.argv[2] || '1558812446144884736';
  line('  examId = ' + examId + '（来自真机日志）');

  // 该卷已不存在于本地，构造一个「字段齐全」的最小 body 即可 ——
  // 我们的目的是看**路径/编码**对状态码的影响，不是真的判分。
  const plain = Buffer.from(JSON.stringify({
    idString: examId,
    questionCnt: 10,
    correctCnt: 10,
    costTime: 3000,
    questions: [],
  }), 'utf8');

  let cipher = null;
  try {
    cipher = native.encodeSubmitBody(plain);
    line('  ✅ 编码成功：明文 ' + plain.length + 'B → 密文 ' + cipher.length + 'B');
  } catch (e) {
    line('  ⚠ 编码失败：' + e.message);
  }

  hr('② 四组对照');

  await put('① 旧路径 + 明文 body', examId, plain, false);
  await new Promise((r) => setTimeout(r, 1500));

  if (cipher) {
    await put('② 旧路径 + 密文 body', examId, cipher, false);
    await new Promise((r) => setTimeout(r, 1500));
  }

  await put('③ /v2/ 路径 + 明文 body', examId, plain, true);
  await new Promise((r) => setTimeout(r, 1500));

  if (cipher) {
    await put('④ /v2/ 路径 + 密文 body', examId, cipher, true);
  }

  hr('判定');
  line('  · ① 401 + ③ 400 ⇒ 路径是 401 的开关（App 踩的就是这个）');
  line('  · ③ 400 + ④ ≠ 401 ⇒ body 必须编码');
  line('  · App 现在走「① 旧路径 + 明文」→ 必然 401');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });