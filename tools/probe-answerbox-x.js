#!/usr/bin/env node
'use strict';
/**
 * 验证猜想：数字题的 400 是不是**笔迹坐标位置不对**（没落在作答框里）。
 *
 * ## 猜想的来源
 *
 * 已知事实：
 *   · 比较题（`5\circle3`，答案 `>`）→ 我们的 ARC 笔迹 **200，判对 20/20**
 *   · 加法题（`27\div3=\square`，答案数字）→ 我们的七段码 **400**
 *   · 真机 script（在比较题上采集）塞进加法题 → **200，判对 10/10**
 *
 * 关键推理：真机那 21 个点落在 `x 177~267, y 482~560`。
 *   若题目是 `1\circle3`（三个字形：`1` `○` `3`），
 *   按「等式从左侧约 x=100 起、每字形约 60~70 宽」估算，
 *   `○` 的中心恰好落在 x≈210 —— 与真机笔迹中心 222 吻合。
 *
 *   而加法题 `27\div3=\square` 有 6 个字形（`2` `7` `÷` `3` `=` `□`），
 *   作答框 `□` 应落在 x≈400~460。
 *   ⇒ 我们却把数字画在 x 125~300（沿用比较题的位置）
 *     → 笔迹不在作答框内 → 服务端判无效 → 400。
 *
 * 比较题之所以侥幸通过：`\circle` 恰好在靠左位置，与我们固定用的
 * 书写区几乎重合。
 *
 * ## 本实验
 *   一次出题，对**同一份笔迹**做多个 x 位移后分别提交
 *   （服务端允许对同一 exam 多次提交，已由 probe-400-cause 证实）。
 *
 *   位移序列：0 → 150 → 275 → 350（覆盖到 x≈400~650 的可能框位）
 *   哪个位移返回非 400，就说明作答框在那个位置。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC_ID = Number(process.argv[2] || 15);
const KP = Number(process.argv[3] || 16);
const NQ = Number(process.argv[4] || 10);
const SHIFTS = (process.argv[5] || '0,150,275,350').split(',').map(Number);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(86)); line(t); line('='.repeat(86)); }

/** 平移整份 script 的 x；script 是 JSON 字符串。 */
function shiftX(scriptStr, dx) {
  let arr;
  try { arr = JSON.parse(scriptStr); } catch (e) { return scriptStr; }
  const out = arr.map((stroke) => (stroke || []).map((p) => ({
    x: Math.round((p.x + dx) * 10000) / 10000,
    y: p.y,
  })));
  return JSON.stringify(out);
}

function bbox(scriptStr) {
  let arr;
  try { arr = JSON.parse(scriptStr); } catch (e) { return null; }
  const xs = [], ys = [];
  for (const st of arr) for (const p of (st || [])) { xs.push(p.x); ys.push(p.y); }
  if (!xs.length) return null;
  return {
    x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs),
    y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys),
  };
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 ' + acc.id + '  知识点 ' + KP + '  题数 ' + NQ);
  line('待试 x 位移: ' + SHIFTS.join(', '));

  hr('出题');
  let g = null;
  for (let i = 0; i < 25; i++) {
    g = await exercise.getExam(jar, KP, NQ, {});
    if (g.status === 200) break;
    if (g.status !== 429) { line('  出题失败 ' + g.status + ': ' + String(g.text).slice(0, 100)); process.exit(0); }
    await sleep(3000);
  }
  if (!g || g.status !== 200) { line('  出题始终被限流'); process.exit(0); }

  const ex = g.json;
  const n = (ex.questions || []).length;
  line('  examId=' + ex.idString + '  题数=' + n);
  line('  题面示例:');
  (ex.questions || []).slice(0, 3).forEach((q) => {
    line('    content=' + JSON.stringify(q.content) + '  answer=' + JSON.stringify(q.answer));
  });

  const body = exercise.answerAll(ex, 200);
  const baseScript = body.questions[0].script;
  const bb = bbox(baseScript);
  line('');
  line('  我们的笔迹（未位移）: x ' + bb.x0.toFixed(1) + '~' + bb.x1.toFixed(1)
    + '   y ' + bb.y0.toFixed(1) + '~' + bb.y1.toFixed(1));
  line('  真机（比较题）参考  : x 177.9~267.7   y 482.3~560.2');

  hr('多位移扫描（同一 exam，逐个提交）');
  const t0 = Date.now();
  const wait = 300 + n * 200;            // 刷分档的等待，够过提交
  const el = Date.now() - t0;
  if (wait > el) await sleep(wait - el);

  for (const dx of SHIFTS) {
    const b = JSON.parse(JSON.stringify(body));
    b.questions.forEach((q) => { q.script = shiftX(q.script, dx); });
    const r = await exercise.submitExam(jar, ex.idString, b, {});
    const nb = bbox(b.questions[0].script);
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('  x+' + String(dx).padStart(3) + '  → 笔迹 x ' + nb.x0.toFixed(0) + '~' + nb.x1.toFixed(0)
      + '   ' + tag
      + (r.status === 200 ? '   服务端判对 ' + ((r.json || {}).correctCnt) + '/' + n : ''));
    if (r.status !== 200) {
      line('       ' + String(r.text || '').slice(0, 120).replace(/\s+/g, ' '));
    } else {
      line('  ★ 作答框应在 x ' + nb.x0.toFixed(0) + '~' + nb.x1.toFixed(0) + ' 附近');
      break;
    }
    await sleep(1200);
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });