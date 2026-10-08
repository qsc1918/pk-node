#!/usr/bin/env node
'use strict';
/**
 * 定出「出题→提交」的**真实最小间隔**（服务端的绝对下限）。
 *
 * ## 为什么重做
 *   上一轮 probe-cost-floor 推翻了「等待 = 声明耗时」的假设：
 *     A 每题 100ms（Σ=0.5s），**0s 提交** → 400
 *     B 每题 3000ms（Σ=15s），**3.1s 提交** → 200
 *   A 与 B 的差别只有**实际间隔**（0s vs 3.1s），声明值不是决定因素。
 *
 *   ⇒ 服务端看的是**绝对时间下限**。这正是我 90s 等待毫无必要的根据：
 *     声明 900ms/题 只影响我自己算出的等待，服务端并不要求那么久。
 *
 * ## 本次：在 3s 附近做梯度，把下限卡到一个可用的安全值
 *   同一份 exam，依次在 0.5 / 1.5 / 2.5 / 3.5 / 5.0s 提交。
 *   注意提交会改变该 exam 的状态，所以每一档都**重新出题**
 *   （429 很紧，档位取少而精）。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const GAPS = (process.argv[4] || '800,1600,2600,3600').split(',').map(Number);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

/** 只填答案 + 一个温和的每题耗时，其余保留原样。 */
function answer(exam, perMs) {
  const clone = JSON.parse(JSON.stringify(exam));
  for (const q of clone.questions || []) {
    const a = (q.answers && q.answers[0]) || q.answer;
    if (a != null) { q.userAnswer = a; q.status = 1; }
    q.costTime = perMs;
  }
  return clone;
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 id=' + acc.id + '  yfd_u=' + acc.yfd_u);
  line('待测间隔: ' + GAPS.map((g) => (g / 1000).toFixed(1) + 's').join(', '));

  hr('梯度实验（每档重新出题）');
  const res = [];
  for (const gap of GAPS) {
    // 出题（带 429 重试）
    let g = null;
    for (let i = 0; i < 12; i++) {
      g = await exercise.getExam(jar, KP, 5, {});
      if (g.status === 200) break;
      if (g.status !== 429) { line('  非频控失败: ' + String(g.text).slice(0, 110)); break; }
      await sleep(10000);
    }
    if (!g || g.status !== 200) { line('  出题不成功，跳过该档'); continue; }

    const t0 = Date.now();
    const wait = gap - (Date.now() - t0);
    if (wait > 0) await sleep(wait);

    const actual = Date.now() - t0;
    const body = answer(g.json, Math.max(5, Math.round(gap / (g.json.questions || [1]).length)));
    const r = await exercise.submitExam(jar, g.json.idString, body, {});
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('  目标 ' + (gap / 1000).toFixed(1) + 's  实际 ' + (actual / 1000).toFixed(1) + 's  → ' + tag);
    if (r.status !== 200) line('      ' + String(r.text || '').slice(0, 110).replace(/\s+/g, ' '));
    res.push({ gap, actual, status: r.status });
    await sleep(2500);
  }

  hr('判定');
  const okGaps = res.filter((x) => x.status === 200).map((x) => x.actual);
  const badGaps = res.filter((x) => x.status !== 200).map((x) => x.actual);
  if (okGaps.length && badGaps.length) {
    line('  通过的最小实际间隔: ' + Math.min.apply(null, okGaps) + 'ms');
    line('  失败的最大实际间隔: ' + Math.max.apply(null, badGaps) + 'ms');
    line('  → 下限落在这两者之间。取「通过值 + 800ms 余量」作默认即可。');
  } else if (okGaps.length) {
    line('  全部通过（测试的下限太低，说明阈值比 ' + Math.min.apply(null, okGaps) + 'ms 还小）');
  } else {
    line('  全部失败 —— 阈值比测试的最大间隔还高，需往上试。');
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });