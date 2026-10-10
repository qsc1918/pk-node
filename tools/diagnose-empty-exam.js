#!/usr/bin/env node
'use strict';
/**
 * 破解 `idString="0"` 之谜 —— 这挡住了一切间隔测量。
 *
 * ## 现象
 *   `probe-cooldown-scope.js`（6 账号同刻并发）里：
 *     id=2 ✅200 **idString="0"**
 *     id=5 ✅200 idString="1758..."（真卷）
 *     id=7 ✅200 **idString="0"**
 * 而刚才 `measure-match-interval.js` 用账号 17：
 *     status=200 但 idString="0" → 判定「起点都没拿到」
 *
 * ## 待判别的假设
 *   H1 空卷 = **静默限流**（服务端不想给 429，就给个空壳）→ 等一会就好了
 *   H2 空卷 = 该账号**被软限**（额度用尽 / 今日已满）→ 等多久都不行
 *   H3 空卷 = 该**知识点**当时没内容 → 换知识点就有
 *
 * ## 本实验（一个矩阵，把三个变量都试到）
 *   对若干账号 × 若干知识点，各打一次：
 *     · 若同账号换知识点仍 `0` ⇒ 不是 H3
 *     · 若同账号等待后再试变真卷 ⇒ H1（时间相关）
 *     · 若该账号始终 `0`、另一账号同时刻有真卷 ⇒ H2（账号相关）
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const IDS = (process.argv[2] || '2,5,7,17,18,22,27,28,32,35,36').split(',').filter(Boolean).map(Number);
const KPS = (process.argv[3] || '235001,16').split(',').filter(Boolean).map(Number);
const NQ = Number(process.argv[4] || 10);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

async function probe(jar, kp) {
  try {
    const g = await exercise.getExam(jar, kp, NQ, {});
    const b = g.json || {};
    return {
      status: g.status,
      idString: b.idString == null ? null : String(b.idString),
      nq: (b.questions || []).length,
      note: String(g.text || '').slice(0, 50).replace(/\s+/g, ' '),
    };
  } catch (e) {
    return { status: null, idString: null, nq: 0, note: e.message };
  }
}

function tag(r) {
  if (r.status === 200 && r.idString && r.idString !== '0') return '✅ 真卷 ' + r.nq + '题';
  if (r.status === 200) return '⚠️ 空卷 idString=' + JSON.stringify(r.idString);
  return '❌ ' + r.status;
}

(async () => {
  db.init();
  line('账号 × 知识点 矩阵，各打一次');

  hr('第一轮：矩阵扫描（同刻，尽量并发以对齐时间）');
  const tasks = [];
  for (const id of IDS) for (const kp of KPS) {
    tasks.push((async () => {
      const a = db.getLeoAccount(id);
      if (!a) return { id: id, kp: kp, r: { status: null, note: '账号不存在' } };
      return { id: id, kp: kp, r: await probe(jobs.jarOf(a), kp) };
    })());
  }
  const out = await Promise.all(tasks);
  let curId = null;
  for (const x of out) {
    if (x.id !== curId) { curId = x.id; line(''); }
    line('  id=' + String(x.id).padEnd(4) + ' kp=' + String(x.kp).padEnd(8)
      + tag(x.r).padEnd(26) + (x.r.note || ''));
  }

  // ── 统计
  const reals = out.filter((x) => x.r.status === 200 && x.r.idString && x.r.idString !== '0');
  const empties = out.filter((x) => x.r.status === 200 && (!x.r.idString || x.r.idString === '0'));
  hr('第一轮统计');
  line('  真卷 ' + reals.length + ' / 空卷 ' + empties.length + ' / 共 ' + out.length);
  const realIds = new Set(reals.map((x) => x.id));
  const emptyIds = new Set(empties.map((x) => x.id));
  line('  能拿真卷的账号: ' + Array.from(realIds).join(', ') || '（无）');
  line('  只拿到空卷的账号: ' + Array.from(emptyIds).join(', ') || '（无）');

  // H3 检验：同账号在不同知识点上表现是否不同
  const byId = {};
  for (const x of out) {
    byId[x.id] = byId[x.id] || [];
    byId[x.id].push(x);
  }
  let h3Hits = 0;
  for (const id of Object.keys(byId)) {
    const arr = byId[id];
    const okN = arr.filter((x) => x.r.status === 200 && x.r.idString && x.r.idString !== '0').length;
    if (okN > 0 && okN < arr.length) h3Hits++;
  }
  line('');
  line('  H3（知识点相关）在 ' + h3Hits + ' 个账号上成立'
    + (h3Hits ? ' → 部分知识点确实出不了卷' : ' → 与知识点无关'));

  // ── H1 检验：对「空卷账号」等待后再试
  if (emptyIds.size) {
    hr('第二轮：对空卷账号等 20s 后重试（H1 时间相关？）');
    line('  等待 20s ...');
    await sleep(20000);
    for (const id of emptyIds) {
      const a = db.getLeoAccount(id);
      const r = await probe(jobs.jarOf(a), KPS[0]);
      line('  id=' + String(id).padEnd(4) + ' 20s 后 → ' + tag(r).padEnd(26) + (r.note || ''));
    }
  }

  hr('判定口径');
  line('  · 若「真卷账号」与「空卷账号」同刻并存 ⇒ 与账号相关（H2 或额度）');
  line('  · 若空卷账号等 20s 后变真卷 ⇒ H1（静默限流，时间相关）');
  line('  · 若同账号换知识点就出真卷 ⇒ H3（知识点相关）');
  line('  · 若空卷来自**刚刚出过题的账号** ⇒ 冷却以「空卷」形式表现');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });