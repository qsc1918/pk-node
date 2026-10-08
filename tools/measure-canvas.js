#!/usr/bin/env node
'use strict';
/**
 * 量出「真机书写区」的真实尺寸 —— 用于给七段码定正确的画布。
 *
 * ## 为什么需要
 *   隔离实验（tools/isolate-400.js）已定论：练习提交 400 的元凶是 **script**。
 *   再比对坐标：
 *
 *     真机（09-27 PK 样本，`>` 比较题）: x 177.9~267.7, y 482.3~560.2
 *     我们（七段码，CANVAS_SIZE=1000）: x 428~586,   y 203.6~796
 *
 *   我们的坐标被放大到 1000 画布，远超真机书写区；服务端判「笔迹不像
 *   在该题作答区书写」→ 直接 400。
 *
 * ## 本脚本
 *   从**所有可用真机样本**里统计坐标值域，反推书写区尺寸：
 *     · /root/alinker/pk_body.json（PK 提交体，含 10 题完整 script）
 *     · 日志里能解出 script 的（多数是密文，可能拿不到）
 *
 *   统计口径：所有题、所有点。
 */
const fs = require('node:fs');

function line(s) { console.log(s); }

/** 递归收集 script 里的所有点。 */
function collectPoints(script, out) {
  let arr = script;
  if (typeof script === 'string') {
    try { arr = JSON.parse(script); } catch (e) { return; }
  }
  if (!Array.isArray(arr)) return;
  for (const a of arr) {
    if (Array.isArray(a)) {
      if (typeof a[0] === 'number' && typeof a[1] === 'number') {
        out.push({ x: a[0], y: a[1] });
      } else {
        collectPoints(a, out);
      }
    } else if (a && typeof a === 'object' && 'x' in a) {
      out.push({ x: a.x, y: a.y });
    }
  }
}

function stats(points, label) {
  if (!points.length) { line('  ' + label + '：无点'); return null; }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const r = {
    n: points.length,
    xMin: Math.min.apply(null, xs), xMax: Math.max.apply(null, xs),
    yMin: Math.min.apply(null, ys), yMax: Math.max.apply(null, ys),
  };
  line('  ' + label);
  line('    点数 ' + r.n);
  line('    x ' + r.xMin.toFixed(1) + ' ~ ' + r.xMax.toFixed(1)
    + '   （跨度 ' + (r.xMax - r.xMin).toFixed(1) + '）');
  line('    y ' + r.yMin.toFixed(1) + ' ~ ' + r.yMax.toFixed(1)
    + '   （跨度 ' + (r.yMax - r.yMin).toFixed(1) + '）');
  return r;
}

line('=' * 84);
line('【1】PK 真机样本（/root/alinker/pk_body.json）');
line('=' * 84);
let all = [];
try {
  const b = JSON.parse(fs.readFileSync('/root/alinker/pk_body.json', 'utf8'));
  const qs = b.questions || [];
  line('  题数 ' + qs.length);
  qs.forEach((q, i) => {
    const pts = [];
    collectPoints(q.script, pts);
    line('  题' + i + '  content=' + JSON.stringify(q.content) + '  answer=' + JSON.stringify(q.answer)
      + '  点 ' + pts.length);
    if (i < 3) stats(pts, '题' + i + ' 值域');
    all = all.concat(pts);
  });
  line('');
  stats(all, '【全部 10 题合计】');
} catch (e) {
  line('  读取失败: ' + e.message);
}

line('');
line('=' * 84);
line('【2】我们当前生成（七段码 CANVAS_SIZE=1000）');
line('=' * 84);
try {
  const strokes = require('/root/pk-node/src/strokes');
  for (const ans of ['9', '42', '123', '>']) {
    const r = strokes.buildPathPoints(ans, 1, 'ARC');
    const pts = [];
    collectPoints(r.strokes, pts);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    line('  answer=' + JSON.stringify(ans) + '  模式=' + r.mode + '  点数 ' + pts.length);
    if (pts.length) {
      line('    x ' + Math.min.apply(null, xs).toFixed(1) + ' ~ ' + Math.max.apply(null, xs).toFixed(1)
        + '   y ' + Math.min.apply(null, ys).toFixed(1) + ' ~ ' + Math.max.apply(null, ys).toFixed(1));
    }
  }
} catch (e) {
  line('  失败: ' + e.message);
}

line('');
line('=' * 84);
line('【3】结论');
line('=' * 84);
line('  真机书写区（由坐标反推）大致就是上面【全部 10 题合计】的值域。');
line('  两者若相差一个数量级 ⇒ 七段码的 CANVAS_SIZE 需要按真机口径缩小。');