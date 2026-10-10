#!/usr/bin/env node
'use strict';
/**
 * 定位「出题成功、提交 401」—— 401 是鉴权问题，与间隔无关。
 *
 * ## 已观测
 *   probe-declare-vs-real.js 用账号 18：
 *     · 出题 ✅ 拿到真卷 idString=1558604...
 *     · 提交 ❌ **401**（五档全是 401，不是 400）
 *
 *   401 = 未授权。两种可能：
 *     H1 该账号的**会话已失效**（cookie 过期 / 被挤下线）→ getExam 恰好不校验
 *     H2 提交这条链路的**签名/参数**在特定条件下不对
 *
 * ## 本实验
 *   对若干账号：出题 → 立刻用最小 body 提交，打印状态码与响应体。
 *   并对照「提交是否与出题间隔有关」（用 3s 这个必然超过下限的间隔）。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const IDS = (process.argv[2] || '15,18,5,32,35,36').split(',').filter(Boolean).map(Number);
const KP = Number(process.argv[3] || 235001);
const NQ = Number(process.argv[4] || 10);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

function buildBody(exam, top) {
  const c = JSON.parse(JSON.stringify(exam));
  const qs = c.questions || [];
  for (const q of qs) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = String(a); q.status = 1; }
    q.costTime = 200;
  }
  c.costTime = top;
  c.correctCnt = qs.length;
  return c;
}

async function matchReal(jar, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const g = await exercise.getExam(jar, KP, NQ, {});
    const b = g.json || {};
    const id = b.idString == null ? null : String(b.idString);
    if (g.status === 200 && id && id !== '0') return { ok: true, exam: g.json };
    await sleep(300);
  }
  return { ok: false };
}

(async () => {
  db.init();
  for (const id of IDS) {
    const a = db.getLeoAccount(id);
    if (!a) { line('id=' + id + ' 不存在，跳过'); continue; }
    const jar = jobs.jarOf(a);
    const m = await matchReal(jar, 120000);
    if (!m.ok) { line('id=' + String(id).padEnd(4) + '出题拿不到真卷，跳过'); continue; }
    const ex = m.exam;
    line('');
    line('id=' + id + '  出题 ✅ idString=' + ex.idString + '  题数=' + (ex.questions || []).length);
    await sleep(3000);
    const r = await exercise.submitExam(jar, String(ex.idString), buildBody(ex, 3000), {});
    line('    提交 3s → ' + (r.status === 200 ? '✅ 200' : '❌ ' + r.status)
      + '   ' + String(r.text || '').slice(0, 90).replace(/\s+/g, ' '));
  }

  hr('判定');
  line('  · 若某些账号 200、某些 401 ⇒ 401 是**账号会话**问题（H1）');
  line('  · 若全部 401 ⇒ 提交链路本身有问题（H2），需查签名/路径');
  line('  · 若全部 200 ⇒ 之前的 401 是该账号临时失效，重试即可');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });