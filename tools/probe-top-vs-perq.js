#!/usr/bin/env node
'use strict';
/**
 * 关键实验：能否「声明上榜速度（0.5s/题）」却「只等 0.2s/题」？
 *
 * ## 已确认（tools/probe-rank-vs-wait.js）
 *
 *   | 组 | 实际间隔 | 声明总耗时 | 结果 |
 *   |----|---------|-----------|------|
 *   | A  | 10.2s   | 10.0s     | ✅ 200 |
 *   | B  | 11.3s   | **25.0s** | ❌ 400 |
 *   | C  | 27.0s   | 25.0s     | ✅ 200 |
 *
 *   ⇒ 服务端要求 **实际间隔 ≥ 声明总耗时**。
 *
 *   若「声明总耗时」= 顶层 `costTime`，且它必须 ≤ 实际间隔，
 *   那 200 题 × 0.5s = 100s 就是必然 —— 用户说不可取。
 *
 * ## 但要先问清一件事：**校验用的是顶层还是每题之和？**
 *
 *   body 里有**两处** costTime：
 *     · 顶层 `costTime`（buildSubmitBody 里 = 每题 × 题数）
 *     · 每题 `questions[i].costTime`
 *
 *   假如服务端只校验**顶层** ≤ 实际间隔，而「上榜速度」是按**每题**折算，
 *   那就能：
 *       每题声明 500ms（速度 0.5s/题 → 上榜）
 *       顶层声明 11000ms（只真等 11s）
 *   —— 两全其美。
 *
 * ## 本实验（题数 50，一次出题）
 *
 *   A 每题500ms 顶层25000ms 间隔12s  → 复现 400（顶层超了）
 *   B 每题500ms 顶层11000ms 间隔13s  → **关键**：顶层够、每题是上榜值
 *   C 每题200ms 顶层11000ms 间隔14s  → 对照（每题也小）
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const NQ = Number(process.argv[4] || 50);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

/** perQ = 每题 costTime；top = 顶层 costTime。 */
function buildBody(exam, perQ, top) {
  const c = JSON.parse(JSON.stringify(exam));
  const qs = c.questions || [];
  for (const q of qs) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = String(a); q.status = 1; }
    q.costTime = perQ;
  }
  c.costTime = top;
  c.correctCnt = qs.length;
  return c;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 ' + acc.id + '  知识点 ' + KP + '  题数 ' + NQ);

  hr('出题');
  let g = null;
  for (let i = 0; i < 30; i++) {
    g = await exercise.getExam(jar, KP, NQ, {});
    if (g.status === 200) break;
    if (g.status !== 429) { line('  出题失败 ' + g.status + ': ' + String(g.text).slice(0, 100)); process.exit(0); }
    await sleep(3000);
  }
  if (!g || g.status !== 200) { line('  出题始终被限流'); process.exit(0); }

  const exam = g.json;
  const n = (exam.questions || []).length;
  const matchOkAt = Date.now();
  line('  examId=' + exam.idString + '  题数=' + n);

  const cases = [
    { name: 'A 每题500 顶层25000', wait: 12000, per: 500, top: 25000 },
    { name: 'B 每题500 顶层11000', wait: 13500, per: 500, top: 11000 },
    { name: 'C 每题200 顶层11000', wait: 15000, per: 200, top: 11000 },
  ];

  hr('逐组提交（间隔递增）');
  for (const c of cases) {
    const need = c.wait - (Date.now() - matchOkAt);
    if (need > 0) await sleep(need);
    const el = Date.now() - matchOkAt;
    const r = await exercise.submitExam(jar, exam.idString, buildBody(exam, c.per, c.top), {});
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('  ' + c.name.padEnd(22)
      + ' 实际 ' + String((el / 1000).toFixed(1)).padStart(5) + 's'
      + '  每题Σ ' + String((c.per * n / 1000).toFixed(1)).padStart(5) + 's'
      + '  顶层 ' + String((c.top / 1000).toFixed(1)).padStart(5) + 's'
      + '  → ' + tag
      + (r.status === 200 ? '  判对 ' + ((r.json || {}).correctCnt) + '/' + n : ''));
    if (r.status !== 200) line('       ' + String(r.text || '').slice(0, 100).replace(/\s+/g, ' '));
    await sleep(700);
  }

  hr('判定');
  line('  B=200 → 校验只看**顶层** costTime！');
  line('      ⇒ 可「每题声明 0.5s/题（上榜速度）」+「顶层声明小（少等）」。');
  line('  B=400 → 校验用**每题之和**；上榜必等 0.5s/题，只能靠少开题。');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });