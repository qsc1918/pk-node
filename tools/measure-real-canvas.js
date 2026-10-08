#!/usr/bin/env node
'use strict';
/**
 * 精确提取真机 script 的「书写区」口径，用于把我们的笔迹对齐到同一坐标系。
 *
 * ## 已知（决定性）
 *   tools/isolate-script-form.js：
 *     真机 script 原样 → ✅ 200，且**服务端判对 10/10**
 *     真机 script 重序列化 → ✅ 200 判对 10/10
 *     我们生成的 script → ❌ 400
 *     script=null → ✅ 200 判对 0
 *
 *   ⇒ 服务端认真机那份笔迹。说明我们差在**字形坐标**：
 *     要让服务端 OCR 认出「这是我们声称的那个答案」，笔迹必须落在
 *     它预期的作答框内、且字形比例正常。
 *
 * ## 本脚本
 *   逐题打印真机 script 的：点数、x/y 值域、以及**每题的答案**。
 *   再与我们的产出并排比较，看出「同一答案下，真机的框在哪、我们的差多少」。
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = '/root/pk-node';

const strokes = require(path.join(ROOT, 'src', 'strokes'));
const REAL = JSON.parse(fs.readFileSync('/root/alinker/pk_body.json', 'utf8'));

function line(s) { console.log(s); }

function ptsOf(script) {
  let arr = script;
  if (typeof script === 'string') { try { arr = JSON.parse(script); } catch (e) { return []; } }
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (const a of arr) {
    if (!Array.isArray(a)) continue;
    for (const p of a) {
      if (p && typeof p === 'object' && 'x' in p) out.push(p);
    }
  }
  return out;
}

function rng(ps) {
  const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  return {
    x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs),
    y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys),
  };
}

line('=' * 96);
line('【1】真机逐题：答案 / 笔数 / 点数 / 坐标值域');
line('=' * 96);
line('  题  答案     笔  点    x 范围                 y 范围');
line('  ' + '-'.repeat(88));
const allReal = [];
(REAL.questions || []).forEach((q, i) => {
  const ps = ptsOf(q.script);
  allReal.push(...ps);
  const r = ps.length ? rng(ps) : null;
  line('  ' + String(i).padStart(2) + '  ' + String(q.answer).padEnd(6)
    + String(Array.isArray(JSON.parse(typeof q.script === 'string' ? q.script : '[]'))
      ? JSON.parse(typeof q.script === 'string' ? q.script : '[]').length : 0).padStart(3)
    + String(ps.length).padStart(5) + '   '
    + (r ? (r.x0.toFixed(1) + ' ~ ' + r.x1.toFixed(1)).padEnd(22) : ''.padEnd(22))
    + (r ? (r.y0.toFixed(1) + ' ~ ' + r.y1.toFixed(1)) : ''));
});
const ar = rng(allReal);
line('');
line('  【全部合计】点 ' + allReal.length);
line('    x ' + ar.x0.toFixed(1) + ' ~ ' + ar.x1.toFixed(1) + '（跨度 ' + (ar.x1 - ar.x0).toFixed(1) + '）');
line('    y ' + ar.y0.toFixed(1) + ' ~ ' + ar.y1.toFixed(1) + '（跨度 ' + (ar.y1 - ar.y0).toFixed(1) + '）');

line('');
line('=' * 96);
line('【2】我们的产出（同答案对照）');
line('=' * 96);
const answers = (REAL.questions || []).map((q) => String(q.answer));
const uniq = Array.from(new Set(answers)).slice(0, 5);
line('  真机出现过的答案: ' + uniq.join(', '));
for (const a of uniq) {
  const r = strokes.buildPathPoints(a, 1, 'ARC');
  const ps = [];
  for (const st of r.strokes) for (const p of st) ps.push(p);
  const g = ps.length ? rng(ps) : null;
  line('  answer=' + JSON.stringify(a).padEnd(6) + ' 模式=' + r.mode.padEnd(14)
    + ' 笔 ' + String(r.strokes.length).padStart(2) + ' 点 ' + String(ps.length).padStart(3));
  if (g) {
    line('      x ' + g.x0.toFixed(1) + ' ~ ' + g.x1.toFixed(1)
      + '   y ' + g.y0.toFixed(1) + ' ~ ' + g.y1.toFixed(1));
  }
}

line('');
line('=' * 96);
line('【3】关键观察');
line('=' * 96);
line('  真机全部点的合计值域就是「书写区」。');
line('  若我们的字形宽高比/位置与真机明显不同，服务端 OCR 认不出 → 400。');
line('  真机答案全是比较符（>/<）—— 这题本来就是比大小题；');
line('  我们的知识点 16（6~10 的加法）答案是数字，字形要单独定。');