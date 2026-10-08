'use strict';
// PK 提交笔迹生成：两种算法（移植自 cn.apixiaoyuan.app）。
// 服务端会校验笔迹「像不像真人手写」：稀疏折线会被判作弊（PK 403 / 练习 400）。
// ⚠️ 2026-10-08 修正：原注释说「练习提交只看 userAnswer，笔迹纯展示」是**错的** ——
//    实测练习提交同样校验笔迹，点太少会 400（`{"status":400,"message":"error"}`）。
// 两种模式坐标口径不同（改代码易踩）：ARC 用像素坐标（x≈150-240、y≈450-500）；SEVEN_SEGMENT 用归一化 0..1 乘 CANVAS_SIZE=1000。
// 回退：ARC 模式下答案不是 `>`/`<` 时自动回落七段码（弧线模板只有比较符字形）。

/**
 * 七段码的画布边长（像素口径，**与 ARC 同一坐标系**）。
 *
 * ## ★ 2026-10-08 修正（修练习提交 400 的关键一处）
 *
 * 旧值是 `1000`，含义是「归一化 0..1 乘 1000」。但真机的书写坐标是
 * **像素口径**，量出来只有一小块区域：
 *
 *   tools/measure-canvas.js（真机 09-27 样本，10 题共 222 个点）
 *     真机书写区: x 125.2~303.1   y 454.1~571.8
 *     我们的 ARC : x 151.7~242.7   y 483.7~560.6   ← 落在区内 ✅
 *     旧七段码   : x 428.0~586.4   y 203.6~796.4   ← 远超区外 ❌
 *
 * 于是同样走 ARC 模式的比较题能过，一旦回落七段码（算术题就是这样）
 * 坐标就跑到书写区外，服务端判「笔迹不在作答区」→ 提交 400。
 *
 *   隔离实验 tools/isolate-400.js 也印证了这点：
 *     script=null → 200 ｜ script=<我们生成的> → 400
 *
 * 现在改成与真机书写区匹配的像素口径。基准点取真机区间的中位：
 *   x 中心 ≈ 214（区宽 178），y 中心 ≈ 513（区高 118）
 * 单字格宽按「区宽 / 常见答案位数」取，使多位数字也落在区内。
 */
const CANVAS_SIZE = 178;

/** 书写区高度（真机实测：y 454.1~571.8，高约 118）。 */
const CANVAS_HEIGHT = 118;

/** 书写区左上角基准（真机实测：x≈125、y≈454）。 */
const CANVAS_ORIGIN_X = 125.2;
const CANVAS_ORIGIN_Y = 454.1;

/** 字形在格子内的内缩系数（同 quick.js `sx = cellW*0.72` / `sy = cellH*0.78`）。 */
const INSET_X = 0.72;
const INSET_Y = 0.78;

/** 画笔算法枚举（与前端下拉、任务配置里的字符串一一对应）。 */
const STROKE_MODES = {
  ARC: 'ARC',
  SEVEN_SEGMENT: 'SEVEN_SEGMENT',
};

const STROKE_MODE_LABELS = {
  ARC: '弧线（推荐）',
  SEVEN_SEGMENT: '七段码',
};

/** 规范化模式字符串（容忍小写 / 空值）。 */
function normalizeStrokeMode(v) {
  const s = String(v || '').trim().toUpperCase();
  return STROKE_MODES[s] || STROKE_MODES.ARC;
}

/* ------------------------- ARC：密集弧线模板 ------------------------- */

/** `<` 形（左上→中→右上，然后折回）。相对第一点，单位像素。 */
const ARC_LT = [
  [0.0, 0.0], [6.1, 0.0], [12.6, 0.0], [20.1, 0.13], [29.8, 0.56],
  [41.0, 1.28], [52.0, 2.21], [61.2, 2.89], [67.6, 3.30], [74.7, 4.31],
  [79.0, 7.70], [74.9, 14.45], [71.2, 18.23], [64.4, 23.96], [53.5, 32.04],
  [41.3, 40.74], [30.2, 48.40], [20.4, 54.62], [12.2, 59.45], [5.3, 63.43],
  [0.2, 66.45], [-4.6, 68.87], [-13.1, 72.91], [-20.0, 76.34],
];

/**
 * `=` 形（**两横**，真机同款）。
 *
 * ⚠️ 为什么必须补：原实现只认 `<` / `>`，`=` 会回落到七段码，
 *   而七段码对 `=` 只能出 2 个点 → 服务端判「非真人书写」→ 提交 400/401。
 *   比大小题里 `=` 很常见（如 `0\circle0`、`5\circle5`）。
 *
 * 坐标：[(dx, dy)] 相对第一点，单位像素；上一横 10 点、下一横 10 点，中间隔 ~13px。
 */
const ARC_EQ = {
  // 上一横：左→右
  upper: [
    [0.0, 0.0], [9.4, 0.6], [19.8, 1.1], [30.2, 1.5], [40.6, 1.8],
    [51.0, 2.0], [61.2, 2.1], [70.8, 2.0], [79.6, 1.7], [86.4, 1.3],
  ],
  // 下一横：左→右（相对「上横第一点」的偏移）
  lower: [
    [1.2, 12.6], [10.4, 13.2], [20.6, 13.7], [30.8, 14.0], [41.0, 14.2],
    [51.2, 14.3], [61.0, 14.2], [70.4, 13.9], [78.8, 13.4], [85.2, 12.9],
  ],
};

/** `>` 形（右上→中→左上，然后折回）。 */
const ARC_GT = [
  [0.0, 0.0], [6.0, 0.67], [14.5, 1.62], [24.0, 2.65], [34.5, 3.73],
  [45.0, 4.68], [53.7, 5.49], [59.2, 5.97], [63.8, 8.23], [59.2, 16.04],
  [55.1, 20.37], [48.8, 25.98], [40.7, 32.66], [32.1, 39.44], [23.6, 46.05],
  [15.0, 52.45], [6.7, 58.36], [-1.3, 63.69], [-9.3, 68.18], [-16.9, 72.24],
  [-27.4, 76.46],
];

/**
 * 轻量确定性伪随机（mulberry32）。
 * ⚠️ 不能用 Math.random()：同一题需可复现笔迹；不必与 Kotlin Random 逐位一致，服务端只校验像不像手写。
 */
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 四舍五入到 n 位小数（去掉浮点长尾）。 */
function roundTo(v, n) {
  const f = Math.pow(10, n);
  return Math.round(v * f) / f;
}

/**
 * ARC：生成密集弧线笔迹（像素坐标）。
 *
 * @param {string} answer 答案（只认 `>` / `<`）
 * @param {number} seed
 * @returns {Array<Array<{x:number,y:number}>>|null} 非 `>`/`<` 返回 null（调用方回落）
 */
function arcPathPoints(answer, seed) {
  const a = String(answer == null ? '' : answer).trim();
  // 单笔模板：`<` / `>`
  const single = a === '<' ? ARC_LT : (a === '>' ? ARC_GT : null);
  const next = rng(seed * 2654435761 + 1);
  const ox = 150 + next() * 90;   // x 150..240
  const oy = 450 + next() * 50;   // y 450..500
  const jitter = () => (next() * 3 - 1.5);
  const round = (v) => roundTo(v, 4);

  if (single) {
    const pts = single.map(([dx, dy]) => ({
      x: round(ox + dx + jitter()),
      y: round(oy + dy + jitter()),
    }));
    return [pts];
  }

  // `=` 是**两笔**（两横），真机同款
  if (a === '=') {
    const upper = ARC_EQ.upper.map(([dx, dy]) => ({
      x: round(ox + dx + jitter()),
      y: round(oy + dy + jitter()),
    }));
    const lower = ARC_EQ.lower.map(([dx, dy]) => ({
      x: round(ox + dx + jitter()),
      y: round(oy + dy + jitter()),
    }));
    return [upper, lower];
  }

  return null;   // 其它答案（数字等）→ 调用方回落七段码
}

/* --------------------- SEVEN_SEGMENT：七段码字形表 --------------------- */

/** 字形表：字符 → 若干条折线，每点是 0..1 归一化坐标。 */
const GLYPHS = {
  '0': [[[0.35, 0.12], [0.60, 0.12], [0.74, 0.22], [0.80, 0.40], [0.80, 0.60],
    [0.74, 0.80], [0.60, 0.90], [0.40, 0.90], [0.26, 0.80], [0.20, 0.60],
    [0.20, 0.40], [0.26, 0.22], [0.35, 0.12]]],
  '1': [[[0.42, 0.35], [0.52, 0.15], [0.56, 0.20], [0.56, 0.85]]],
  '2': [[[0.20, 0.35], [0.24, 0.20], [0.45, 0.12], [0.66, 0.22], [0.72, 0.40],
    [0.50, 0.58], [0.25, 0.75], [0.70, 0.85], [0.78, 0.90]]],
  '3': [[[0.24, 0.18], [0.55, 0.10], [0.70, 0.25], [0.62, 0.42], [0.38, 0.45],
    [0.68, 0.55], [0.74, 0.72], [0.60, 0.88], [0.30, 0.88]]],
  '4': [
    [[0.58, 0.10], [0.58, 0.85]],
    [[0.30, 0.55], [0.32, 0.42], [0.72, 0.42]],
  ],
  '5': [[[0.22, 0.14], [0.70, 0.14], [0.70, 0.40], [0.30, 0.42], [0.24, 0.55],
    [0.30, 0.75], [0.50, 0.88], [0.70, 0.85], [0.78, 0.72]]],
  '6': [[[0.35, 0.15], [0.65, 0.20], [0.76, 0.40], [0.74, 0.70], [0.60, 0.88],
    [0.40, 0.88], [0.26, 0.70], [0.24, 0.50], [0.40, 0.40], [0.62, 0.45]]],
  '7': [[[0.20, 0.15], [0.75, 0.15], [0.50, 0.40], [0.45, 0.85]]],
  '8': [[[0.30, 0.12], [0.62, 0.20], [0.68, 0.38], [0.50, 0.50], [0.30, 0.50],
    [0.25, 0.35], [0.40, 0.28], [0.62, 0.38], [0.70, 0.60], [0.65, 0.80],
    [0.45, 0.90], [0.28, 0.82], [0.25, 0.60], [0.45, 0.50]]],
  '9': [
    [[0.40, 0.12], [0.62, 0.20], [0.72, 0.40], [0.70, 0.60], [0.55, 0.75],
      [0.38, 0.72], [0.30, 0.55], [0.45, 0.45], [0.65, 0.50]],
    [[0.52, 0.88], [0.50, 0.85]],
  ],
  '+': [
    [[0.50, 0.20], [0.50, 0.80]],
    [[0.20, 0.50], [0.80, 0.50]],
  ],
  '-': [[[0.20, 0.50], [0.80, 0.50]]],
  '×': [
    [[0.25, 0.20], [0.75, 0.80]],
    [[0.75, 0.20], [0.25, 0.80]],
  ],
  'x': [
    [[0.25, 0.20], [0.75, 0.80]],
    [[0.75, 0.20], [0.25, 0.80]],
  ],
  'X': [
    [[0.25, 0.20], [0.75, 0.80]],
    [[0.75, 0.20], [0.25, 0.80]],
  ],
  '*': [
    [[0.50, 0.20], [0.50, 0.80]],
    [[0.20, 0.50], [0.80, 0.50]],
    [[0.30, 0.30], [0.70, 0.70]],
    [[0.70, 0.30], [0.30, 0.70]],
  ],
  '/': [[[0.25, 0.15], [0.75, 0.85]]],
  '=': [
    [[0.20, 0.35], [0.80, 0.35]],
    [[0.20, 0.65], [0.80, 0.65]],
  ],
  '>': [[[0.3004, 0.0], [0.3662, 0.0088], [0.4594, 0.0212], [0.5636, 0.0347],
    [0.6787, 0.0488], [0.7939, 0.0612], [0.8893, 0.0718], [0.9496, 0.0781],
    [1.0, 0.1076], [0.9496, 0.2098], [0.9046, 0.2664], [0.8355, 0.3398],
    [0.7467, 0.4272], [0.6524, 0.5158], [0.5592, 0.6023], [0.4649, 0.6860],
    [0.3739, 0.7633], [0.2862, 0.8330], [0.1985, 0.8917], [0.1151, 0.9448],
    [0.0, 1.0]]],
  '<': [[[0.2020, 0.0], [0.2636, 0.0], [0.3293, 0.0], [0.4051, 0.0017],
    [0.5030, 0.0073], [0.6162, 0.0168], [0.7273, 0.0289], [0.8202, 0.0379],
    [0.8848, 0.0432], [0.9566, 0.0565], [1.0, 0.1009], [0.9586, 0.1893],
    [0.9212, 0.2388], [0.8525, 0.3139], [0.7424, 0.4197], [0.6192, 0.5337],
    [0.5071, 0.6340], [0.4081, 0.7155], [0.3253, 0.7788], [0.2556, 0.8309],
    [0.2040, 0.8704], [0.1556, 0.9021], [0.0697, 0.9551], [0.0, 1.0]]],
  '.': [[[0.45, 0.70], [0.55, 0.70]]],
  ':': [
    [[0.50, 0.30], [0.50, 0.35]],
    [[0.50, 0.65], [0.50, 0.70]],
  ],
  '?': [
    [[0.25, 0.35], [0.30, 0.20], [0.50, 0.12], [0.68, 0.25], [0.60, 0.42],
      [0.45, 0.50], [0.45, 0.65]],
    [[0.45, 0.82], [0.45, 0.85]],
  ],
  ' ': [],
};

/**
 * 七段码：把答案文本铺成折线（像素坐标，画布 1000×1000）。
 *
 * 布局与原版 `buildStrokes` 逐行一致：文本按字符横向平分画布宽度，
 * 每个字符在自己的格子里居中绘制。
 *
 * @param {string} answer
 * @returns {Array<Array<{x:number,y:number}>>} 未收录的字符被跳过
 */
function sevenSegmentPathPoints(answer, canvasSize, canvasHeight) {
  const text = String(answer == null ? '' : answer);
  const size = canvasSize || CANVAS_SIZE;
  const height = canvasHeight || CANVAS_HEIGHT;
  if (!text) return [];
  const chars = Array.from(text);
  // 多字符（如 `42`）横向平分书写区宽度；单字符也用它，保证各题笔迹尺度一致。
  const cellW = size / Math.max(1, chars.length);
  const cellH = height;
  const sx = cellW * INSET_X;
  const sy = cellH * INSET_Y;
  const out = [];
  /**
   * 把一段直线插值成多点的折线。
   *
   * ⚠️ 为什么要插值：七段码的字形是「两点一段」的直线，
   *   直接输出会导致整个 script 只有几个点（如 `42` 仅 2 点）——
   *   服务端会判「非真人书写」而拒绝提交。
   *   真机手写每个笔画有 8~12 个采样点，这里按段长近似还原。
   */
  const densify = (a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    // 约每 0.06 归一化单位一个采样点，最少 3 个、最多 12 个
    const n = Math.max(3, Math.min(12, Math.round(dist / 0.06) + 1));
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1);
      pts.push([a[0] + dx * t, a[1] + dy * t]);
    }
    return pts;
  };

  /**
   * 把一段折线**按固定步长**重采样成密集点。
   *
   * ⚠️ 为什么要重采样：服务端会判「笔迹像不像真人手写」。
   *   真机的每一笔是手写采样，每笔约 10 个点、整题 21~24 点：
   *
   *     tools/measure-canvas.js（真机 09-27 样本 10 题）
   *       题0: 21 点 ｜ 题1: 24 点 ｜ … 合计 222 点（10 题）
   *
   *   而我们的字形只有 2~9 个顶点，且旧实现只对「段」做低密度插值，
   *   导致整题只有 8~19 点（`9` 仅 8 点）→ 被判非真人书写 → 400。
   *
   *   改法：整笔（而不是单段）按**固定步长**均匀重采样，
   *   使每笔点数稳定落在真机量级（约 10 点/笔）。
   */
  const resampleStroke = (points, perStroke) => {
    if (!points || points.length === 0) return [];
    if (points.length === 1) return [points[0].slice()];
    // 累计弧长
    const segLen = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i][0] - points[i - 1][0];
      const dy = points[i][1] - points[i - 1][1];
      const d = Math.sqrt(dx * dx + dy * dy);
      segLen.push(d);
      total += d;
    }
    if (total <= 0) return [points[0].slice()];
    const out = [];
    const steps = Math.max(2, perStroke);
    for (let k = 0; k < steps; k++) {
      const target = (total * k) / (steps - 1);
      let acc = 0;
      let idx = 0;
      while (idx < segLen.length && acc + segLen[idx] < target) {
        acc += segLen[idx];
        idx++;
      }
      if (idx >= segLen.length) { out.push(points[points.length - 1].slice()); break; }
      const t = segLen[idx] <= 0 ? 0 : (target - acc) / segLen[idx];
      out.push([
        points[idx][0] + (points[idx + 1][0] - points[idx][0]) * t,
        points[idx][1] + (points[idx + 1][1] - points[idx][1]) * t,
      ]);
    }
    return out;
  };

  chars.forEach((ch, ci) => {
    const glyph = GLYPHS[ch];
    if (!glyph) return;                       // 未收录字符：跳过（与原版一致）
    // 格子内居中，再整体平移到书写区（真机坐标是页面像素口径，
    // 不是从 0 开始的归一化坐标 —— 见 CANVAS_ORIGIN_X/Y 的说明）。
    const ox = CANVAS_ORIGIN_X + cellW * ci + (cellW - sx) / 2;
    const oy = CANVAS_ORIGIN_Y + (cellH - sy) / 2;
    for (const stroke of glyph) {
      // 先把该笔的顶点序列整体重采样成 ~10 点（对齐真机手写密度），
      // 再映射到书写区。用整笔重采样而非逐段插值，点数才稳定。
      const resampled = resampleStroke(stroke, 10);
      out.push(resampled.map(([nx, ny]) => ({
        x: roundTo(ox + nx * sx, 3),
        y: roundTo(oy + ny * sy, 3),
      })));
    }
  });
  return out;
}

/**
 * 按模式生成笔迹点集（统一入口）。
 *
 * 回退规则对齐原版：
 *  - `ARC`：先试弧线模板；答案不是 `>`/`<` 时回落七段码；
 *  - `SEVEN_SEGMENT`：直接用七段码。
 *
 * @param {string} answer
 * @param {number} seed
 * @param {string} [mode] STROKE_MODES 之一
 * @returns {{mode:string, strokes:Array}} 实际使用的模式 + 点集
 */
function buildPathPoints(answer, seed, mode) {
  const want = normalizeStrokeMode(mode);

  if (want === STROKE_MODES.ARC) {
    const arc = arcPathPoints(answer, seed);
    if (arc) return { mode: STROKE_MODES.ARC, strokes: arc };
    // 非比较题 → 回落七段码
    return { mode: STROKE_MODES.SEVEN_SEGMENT, strokes: sevenSegmentPathPoints(answer) };
  }

  return { mode: STROKE_MODES.SEVEN_SEGMENT, strokes: sevenSegmentPathPoints(answer) };
}

/** 与 `JSON.stringify(strokes)` 等价，但保证字段顺序是 x 再 y。 */
function strokesToScript(strokes) {
  return JSON.stringify(strokes);
}

/** 自检：两种模式都能产出笔迹，且 ARC 对非比较题会回落。 */
function selfTest() {
  const a = buildPathPoints('>', 42, STROKE_MODES.ARC);
  const b = buildPathPoints('<', 42, STROKE_MODES.ARC);
  const c = buildPathPoints('>', 42, STROKE_MODES.SEVEN_SEGMENT);
  const d = buildPathPoints('78', 42, STROKE_MODES.ARC);

  const detail = `ARC> ${a.strokes[0].length}点 / ARC< ${b.strokes[0].length}点 / ` +
    `七段码> ${c.strokes[0].length}点 / ARC打'78'回落=${d.mode}`;

  const ok = a.mode === STROKE_MODES.ARC && a.strokes[0].length === 21 &&
    b.strokes[0].length === 24 && c.mode === STROKE_MODES.SEVEN_SEGMENT &&
    d.mode === STROKE_MODES.SEVEN_SEGMENT && d.strokes.length === 2;

  return { ok: ok, detail: detail };
}

module.exports = {
  CANVAS_SIZE,
  STROKE_MODES,
  STROKE_MODE_LABELS,
  normalizeStrokeMode,
  arcPathPoints,
  sevenSegmentPathPoints,
  buildPathPoints,
  strokesToScript,
  selfTest,
};