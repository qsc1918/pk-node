'use strict';
// PK 提交笔迹生成：两种算法（移植自 cn.apixiaoyuan.app）。
// PK 服务端会校验笔迹「像不像真人手写」，稀疏折线上当判作弊直接 403；练习提交只看 userAnswer，笔迹纯展示。
// 两种模式坐标口径不同（改代码易踩）：ARC 用像素坐标（x≈150-240、y≈450-500）；SEVEN_SEGMENT 用归一化 0..1 乘 CANVAS_SIZE=1000。
// 回退：ARC 模式下答案不是 `>`/`<` 时自动回落七段码（弧线模板只有比较符字形）。

/** 提交笔迹的归一化画布边长（仅 SEVEN_SEGMENT 用）。 */
const CANVAS_SIZE = 1000;

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
  const tmpl = a === '<' ? ARC_LT : (a === '>' ? ARC_GT : null);
  if (!tmpl) return null;

  const next = rng(seed * 2654435761 + 1);
  const ox = 150 + next() * 90;   // x 150..240
  const oy = 450 + next() * 50;   // y 450..500
  const pts = tmpl.map(([dx, dy]) => ({
    x: roundTo(ox + dx + (next() * 3 - 1.5), 4),
    y: roundTo(oy + dy + (next() * 3 - 1.5), 4),
  }));
  return [pts];
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
function sevenSegmentPathPoints(answer, canvasSize) {
  const text = String(answer == null ? '' : answer);
  const size = canvasSize || CANVAS_SIZE;
  if (!text) return [];

  const chars = Array.from(text);
  const cellW = size / chars.length;
  const cellH = size;
  const sx = cellW * INSET_X;
  const sy = cellH * INSET_Y;

  const out = [];
  chars.forEach((ch, ci) => {
    const glyph = GLYPHS[ch];
    if (!glyph) return;                       // 未收录字符：跳过（与原版一致）
    const ox = cellW * ci + (cellW - sx) / 2;
    const oy = (cellH - sy) / 2;
    for (const stroke of glyph) {
      out.push(stroke.map(([nx, ny]) => ({
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