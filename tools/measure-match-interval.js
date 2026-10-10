#!/usr/bin/env node
'use strict';
/**
 * 精确测量「出题间隔」—— 回答「是不是 1s 左右」。
 *
 * ## 为什么重做
 *   我上一版 tools/recheck-cooldown.js 的**腿二有 bug**：
 *
 *     if (lastOk2) { need = 1200 - (Date.now() - lastOk2); if (need>0) await sleep(need); }
 *
 *   `lastOk2` 只在**成功**后才赋值；而腿二从未成功过 →
 *   `if (lastOk2)` 恒假 → **一次都没等**，全是背靠背连发。
 *   所以「1.2s 间隔也一样 429」这个结论是**假的**（根本没测 1.2s）。
 *
 * ## 本实验（两个互补的相位）
 *
 *   ### 相位 A：轮询精测真实冷却
 *     拿到一次真成功后，**每 100ms 探一次**，直到再次真成功 →
 *     这个间隔就是服务端的真实冷却（不受"等多少"的主观影响）。
 *     连续测 3 轮，取中位数。
 *
 *   ### 相位 B：定长间隔对照（修掉上个 bug）
 *     不再依赖「上次成功」做基准，而是**显式计时**：
 *       成功 → sleep(G) → 立刻打 → 记结果
 *     G 依次取 800 / 1000 / 1200 / 1500 ms，各用一个**独立账号**，
 *     避免互相污染。
 *
 * ## 还有一件必须同时查清的事
 *   上一轮 `probe-cooldown-scope` 看到 id=2 / id=7 返回 `"idString":"0"`。
 *   若「200 但 idString=0」是**被静默拒绝的空卷**，那它可能：
 *     · 不消耗冷却（数量上的假成功）
 *     · 或者 是另一种限流的表现
 *   本工具对**每次 200** 都打印 idString，用于判别。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_MAIN = Number(process.argv[2] || 17);            // 相位 A 用
const KP = Number(process.argv[3] || 235001);
const NQ = Number(process.argv[4] || 100);
const ROUNDS = Number(process.argv[5] || 3);
// 相位 B：格式 "账号id:间隔ms,账号id:间隔ms"
const PAIRS = (process.argv[6] || '18:800,22:1000,27:1200,28:1500')
  .split(',').filter(Boolean).map((s) => {
    const p = s.split(':');
    return { id: Number(p[0]), gap: Number(p[1]) };
  });

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

/**
 * 发起一次出题。
 * ★ 「真成功」= status 200 **且** idString 非 "0"、非空。
 *   （idString=0 疑似空卷，单独标注，不当作拿到卷。）
 */
async function probe(jar) {
  const t = Date.now();
  let g;
  try {
    g = await exercise.getExam(jar, KP, NQ, {});
  } catch (e) {
    return { status: null, ms: Date.now() - t, idString: null, note: e.message };
  }
  const ms = Date.now() - t;
  const body = g.json || {};
  const idString = body.idString == null ? null : String(body.idString);
  const nq = (body.questions || []).length;
  return {
    status: g.status, ms: ms, idString: idString, nq: nq,
    empty: idString === '0' || idString === '' || idString === 'null',
    note: String(g.text || '').slice(0, 60).replace(/\s+/g, ' '),
  };
}

function isReal(r) { return r.status === 200 && r.idString && !r.empty; }

/** 轮询直到「真成功」（或超时），返回 {ok, waited, last} */
async function waitReal(jar, maxMs, pollMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < maxMs) {
    last = await probe(jar);
    if (isReal(last)) return { ok: true, waited: Date.now() - t0, r: last };
    await sleep(pollMs);
  }
  return { ok: false, waited: Date.now() - t0, r: last };
}

(async () => {
  db.init();

  // ────────────────────────────────────────────────────────
  hr('相位 A：轮询精测真实出题间隔（账号 ' + ACC_MAIN + '，' + NQ + ' 题）');
  const acc = db.getLeoAccount(ACC_MAIN);
  if (!acc) { line('找不到账号 ' + ACC_MAIN); process.exit(1); }
  const jarA = jobs.jarOf(acc);

  line('  先等一次真成功作起点（最多 180s，每 300ms 探）...');
  const first = await waitReal(jarA, 180000, 300);
  if (!first.ok) {
    line('  起点都没拿到：status=' + (first.r && first.r.status) + ' ' + (first.r && first.r.note));
    process.exit(0);
  }
  line('  起点 examId=' + first.r.idString + '  题数=' + first.r.nq
    + '  （耗时 ' + (first.waited / 1000).toFixed(2) + 's）');

  const gaps = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const t0 = Date.now();
    await sleep(100);                       // 立刻探一次也行，但留 100ms 免得纯背靠背
    const r = await waitReal(jarA, 180000, 100);
    const gap = Date.now() - t0;
    if (r.ok) gaps.push(gap);
    line('    第 ' + i + ' 轮间隔  ' + (r.ok ? '✅ ' + (gap / 1000).toFixed(2) + 's' : '❌ 超时')
      + '   examId=' + (r.r && r.r.idString)
      + (r.ok ? '' : '  ' + (r.r && r.r.note)));
  }
  if (gaps.length) {
    const sorted = gaps.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    line('');
    line('  实测间隔: ' + gaps.map((x) => (x / 1000).toFixed(2) + 's').join(', '));
    line('  ⇒ 中位数 **' + (med / 1000).toFixed(2) + 's**');
    line('  （用户猜「1s 左右」→ 中位数 ' + (med / 1000).toFixed(2) + 's，'
      + (med < 3000 ? '接近，✅ 吻合' : '不符，明显更长 ❌') + '）');
  }

  // ────────────────────────────────────────────────────────
  hr('相位 B：定长间隔对照（显式计时，已修掉上一版的 bug）');
  line('  每个账号：拿到真成功 → 精确 sleep(G) → 立刻打一次 → 记结果');
  line('');
  for (const p of PAIRS) {
    const a = db.getLeoAccount(p.id);
    if (!a) { line('  id=' + p.id + ' 账号不存在，跳过'); continue; }
    const jar = jobs.jarOf(a);

    const base = await waitReal(jar, 180000, 300);
    if (!base.ok) {
      line('  id=' + String(p.id).padEnd(4) + '起点未拿到（' + (base.r && base.r.status) + '），跳过');
      continue;
    }
    // ★ 显式计时：以「刚成功」的时刻为 t0
    const t0 = Date.now();
    await sleep(p.gap);
    const real = Date.now() - t0;            // 真实间隔（sleep 会有几 ms 漂移）
    const r = await probe(jar);
    const tag = isReal(r) ? '✅ 真成功' : (r.status === 200 ? '⚠️ 200 但 idString=' + r.idString : '❌ ' + r.status);
    line('  id=' + String(p.id).padEnd(4) + '间隔 ' + String(real).padStart(5) + 'ms  →  '
      + tag + (r.note && !isReal(r) ? '   ' + r.note : ''));
  }

  // ────────────────────────────────────────────────────────
  hr('相位 C：idString=0 是不是「假成功」？');
  line('  取一个刚放行的账号，连打两次，看 idString 与状态码。');
  {
    const a = db.getLeoAccount(PAIRS.length ? PAIRS[0].id : ACC_MAIN);
    const jar = jobs.jarOf(a);
    for (let i = 1; i <= 3; i++) {
      const r = await probe(jar);
      line('    第 ' + i + ' 次: status=' + r.status
        + '  idString=' + JSON.stringify(r.idString)
        + '  题数=' + r.nq
        + (r.empty ? '   ← 空卷（假成功？）' : ''));
      await sleep(2500);
    }
  }

  hr('判定口径');
  line('  · 相位 A 中位数 = 服务端**真实**出题冷却（客观）');
  line('  · 相位 B 若 G=800/1000 就真成功 ⇒ 冷却确实 ~1s，你猜对了');
  line('  · 若只有 G≥1500 才成功 ⇒ 冷却在 1.5s 以上');
  line('  · 相位 C 若稳定出现 idString=0 ⇒ 那是**另一种限流**（要单独处理）');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });