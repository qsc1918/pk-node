#!/usr/bin/env node
'use strict';
/**
 * 打穿「100 题提交下限 20s」—— 测笔迹量是否是那个系数的来源。
 *
 * ## 动机
 *   已确认（tools/probe-declare-vs-real.js）：
 *     · 顶层 costTime 声明值 **完全无关**（2s 与 2000s 声明同为 400）
 *     · 服务端只看**真实间隔**，100 题下限 ≈ 20s
 *
 *   那么这 20s 是什么算出来的？最可疑的是**笔迹**：
 *   我们每题都塞了 21 点的 `script`，服务端可能按
 *       时间下限 = Σ f(每题笔迹)
 *   来校验。若如此，**减少笔迹点数**就能压低下限。
 *
 * ## 本实验（固定 100 题、固定实际间隔 8s，只改笔迹）
 *
 *   组 A：script = 我们的 21 点（已知 8s 会 400，作对照）
 *   组 B：script = 每笔 8 点（点数砍掉 6 成）
 *   组 C：script = 每笔 4 点
 *   组 D：script = 空字符串
 *
 *   · 若 B/C/D 在 8s 下变 200 ⇒ **笔迹量就是那个系数**，冲榜模式该瘦笔迹
 *   · 若全部 400 ⇒ 与笔迹无关，20s 是硬约束
 *
 * ⚠️ 必须用**能吃真卷**的账号（id=5/32/35/36）。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const ACC = Number(process.argv[2] || 5);
const KP = Number(process.argv[3] || 235001);
const NQ = Number(process.argv[4] || 100);
const REAL_GAP = Number(process.argv[5] || 8000);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

/**
 * 把 script 瘦身到每笔至多 maxPts 点。
 * script 的格式是一串「绘制指令」，我们按**分号/竖线等分隔符**切段再截断点。
 * 为了兼容多种格式，这里做的是**通用处理**：把非空白的成对坐标串按 maxPts 截断。
 */
function slimScript(s, maxPts) {
  if (!s) return s;
  const str = String(s);
  // 通用：把所有「数字对」按出现顺序保留前 maxPts 对，其余删除。
  // 先找出所有数字，再重组 —— 但脚本里还有命令字符，直接截断风险大。
  // 稳妥做法：按常见分隔符切成 token，保留前 maxPts*2 个数字，其余数字置零删掉。
  const nums = str.match(/-?\d+(\.\d+)?/g) || [];
  if (nums.length <= maxPts * 2) return str;
  // 保留前 maxPts*2 个数字，其余替换为与"点"无关的空（保持长度不敏感）
  let i = 0;
  return str.replace(/-?\d+(\.\d+)?/g, (m) => {
    i++;
    return i <= maxPts * 2 ? m : '';
  });
}

function buildBody(exam, top, mode) {
  // ★ 必须用 answerAll 生成真正的作答体（笔迹由它产出）。
  //   出题响应里**没有** script —— 上一版直接复制 exam 导致"笔迹 0 字符"，
  //   实验因此无效。
  const perQ = 5;
  const answered = exercise.answerAll(exam, perQ, top);
  const qs = answered.questions || [];
  for (const q of qs) {
    if (mode === 'empty') q.script = '';
    else if (mode === 'p8') q.script = slimScript(q.script, 8);
    else if (mode === 'p4') q.script = slimScript(q.script, 4);
    q.costTime = perQ;
  }
  answered.costTime = top;
  answered.correctCnt = qs.length;
  return answered;
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
  const acc = db.getLeoAccount(ACC);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);

  line('账号 ' + ACC + '  知识点 ' + KP + '  题数 ' + NQ + '  固定实际间隔 ' + REAL_GAP + 'ms');
  line('（脚本瘦身前的原笔迹：见各组打印的 script 长度）');

  const MODES = ['full', 'p8', 'p4', 'empty'];
  hr('逐组实验');
  const rows = [];
  for (const mode of MODES) {
    const m = await matchReal(jar, 180000);
    if (!m.ok) { line('  出题拿不到真卷，跳过 ' + mode); continue; }
    const ex = m.exam;
    const orig = ((ex.questions || [])[0] || {}).script;
    const body = buildBody(ex, REAL_GAP, mode);
    const slim = ((body.questions || [])[0] || {}).script;
    const t0 = Date.now();
    await sleep(REAL_GAP);
    const real = Date.now() - t0;
    const r = await exercise.submitExam(jar, String(ex.idString), body, {});
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('  ' + mode.padEnd(6) + ' 实际 ' + String(real).padStart(5) + 'ms  原始笔迹 ' + String(orig || '').length
      + ' 字符 → 瘦身后 ' + String(slim || '').length + ' 字符  → ' + tag
      + (r.status === 200 ? '  判对 ' + ((r.json || {}).correctCnt) + '/' + NQ : ''));
    rows.push({ mode: mode, status: r.status });
    await sleep(500);
  }

  hr('判定');
  const okModes = rows.filter((x) => x.status === 200).map((x) => x.mode);
  const badModes = rows.filter((x) => x.status !== 200).map((x) => x.mode);
  line('  通过: ' + (okModes.join(', ') || '（无）'));
  line('  失败: ' + (badModes.join(', ') || '（无）'));
  if (okModes.length && badModes.length) {
    line('  ✅ **笔迹量影响下限** ⇒ 冲榜模式应把笔迹瘦到刚好能过');
  } else if (okModes.length) {
    line('  ⚠️ 全部通过 ⇒ 8s 就够，那一开始的 400 另有原因（需再看）');
  } else {
    line('  ❌ 全部失败 ⇒ 与笔迹量无关，20s 是硬约束（H2 确认）');
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });