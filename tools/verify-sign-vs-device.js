#!/usr/bin/env node
'use strict';
/**
 * 用真机抓包反验 pk-node 的 sign 管线。
 *
 * ## 为什么必须这么验
 *
 * sign 每分钟变，拿「现在算的值」比「真机那时的值」没有意义。
 * 但 T = f(时刻) 是**确定性函数** —— 用真机当时的秒数重算 T，再算 sign，
 * 就能一次判定「T 生成 + chainMd5 公式」整条管线对不对。
 *
 * 判定：
 *   · 全部命中 → sign 管线正确，417 不是 sign 的锅（往请求头找）
 *   · 全不命中 → T 或公式有问题，这就是 417 的真因
 *
 * 用法：node tools/verify-sign-vs-device.js
 */
const fs = require('fs');
const { calcT } = require('../src/lre-emu');
const { chainMd5 } = require('../src/sign');

const LOG = process.env.PK_LOG || '/sdcard/Download/leo-logs/auto_oral-2026-10-08.log';

let text;
try {
  text = fs.readFileSync(LOG, 'latin1');
} catch (e) {
  console.error('读不到日志：' + LOG);
  process.exit(1);
}
const lines = text.split('\n');

/* ---------- 1) 取样本：path + sign + 请求时间戳 ---------- */
const samples = [];
for (let i = 0; i < lines.length; i++) {
  const m = /\[PKT\]\[REQ\]\s+(\w+)\s+(\S+)/.exec(lines[i]);
  if (!m) continue;
  const url = m[2];
  const sm = /[?&]sign=([0-9a-f]{32})/.exec(url);
  if (!sm) continue;

  let ts = null;
  for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
    const tm = /X-XYKS-REQ-TIMESTAMP:\s*(\d{10,})/.exec(lines[j]);
    if (tm) { ts = Number(tm[1]); break; }
  }
  samples.push({
    method: m[1],
    full: url,
    path: url.split('?')[0],
    query: url.indexOf('?') >= 0 ? url.slice(url.indexOf('?') + 1) : '',
    sign: sm[1],
    ts: ts,
  });
}

const seen = new Set();
const uniq = [];
for (const s of samples) {
  const k = s.path + '|' + s.sign;
  if (seen.has(k)) continue;
  seen.add(k);
  uniq.push(s);
}

console.log('日志: ' + LOG);
console.log('带 sign 的请求: ' + samples.length + ' 条，去重后 ' + uniq.length + ' 条');

const withTs = uniq.filter(function (s) { return s.ts; });
console.log('其中带时间戳可反验: ' + withTs.length + ' 条');
console.log();

/* ---------- 2) 预先算 T（同分钟复用） ---------- */
const VARIANTS = ['exercise', 'pk'];
const WINDOWS = [0, -60, 60];

const needT = new Map();
for (const s of withTs) {
  const sec = Math.floor(s.ts / 1000);
  for (const w of WINDOWS) {
    for (const v of VARIANTS) {
      const epoch = sec + w;
      needT.set(epoch + '|' + v, { epoch: epoch, variant: v });
    }
  }
}

console.log('需要计算 T: ' + needT.size + ' 组...');
const tCache = new Map();
let n = 0;
for (const item of needT.values()) {
  const k = item.epoch + '|' + item.variant;
  try {
    tCache.set(k, calcT(item.epoch, item.variant));
  } catch (e) {
    tCache.set(k, null);
  }
  n++;
  if (n % 8 === 0) process.stderr.write('  已算 ' + n + '/' + needT.size + '\n');
}
process.stderr.write('  T 计算完成\n\n');

/* ---------- 3) 枚举「path 形态」的组合，找出真机用的是哪种 ---------- */
function encodePath(p, mode) {
  if (mode === 'raw') return p;
  if (mode === 'no-leading-slash') return p.replace(/^\//, '');
  if (mode === 'encodeURIComponent-then-slash-fix') return encodeURIComponent(p).replace(/%2F/gi, '/');
  if (mode === 'encodeURI') return encodeURI(p);
  return p;
}
const PATH_MODES = ['raw', 'no-leading-slash', 'encodeURI', 'encodeURIComponent-then-slash-fix'];

let hit = 0;
let miss = 0;
const hitDetail = {};

for (const s of withTs.slice(0, 20)) {
  const sec = Math.floor(s.ts / 1000);
  let found = null;

  for (const w of WINDOWS) {
    if (found) break;
    for (const v of VARIANTS) {
      if (found) break;
      const T = tCache.get((sec + w) + '|' + v);
      if (!T) continue;
      for (const pm of PATH_MODES) {
        const cand = encodePath(s.path, pm);
        let got;
        try { got = chainMd5(cand, T); } catch (e) { continue; }
        if (got === s.sign) {
          found = { window: w, variant: v, mode: pm };
          break;
        }
      }
    }
  }

  if (found) {
    hit++;
    const key = found.variant + '/' + found.mode + '/w' + found.window;
    hitDetail[key] = (hitDetail[key] || 0) + 1;
    console.log('[命中] ' + found.variant + ' + ' + found.mode + ' + ' + found.window + 's   ' + s.path);
  } else {
    miss++;
    console.log('[未命中] ' + s.path);
    console.log('         真机 = ' + s.sign);
    for (const v of VARIANTS) {
      for (const w of [0, -60]) {
        const T = tCache.get((sec + w) + '|' + v);
        if (!T) continue;
        console.log('         本机 ' + v + '/' + w + 's = ' + chainMd5(s.path, T));
      }
    }
  }
}

console.log();
console.log('='.repeat(70));
console.log('命中 ' + hit + ' / 未命中 ' + miss);
for (const k of Object.keys(hitDetail)) {
  console.log('  命中组合 ' + k + ' : ' + hitDetail[k] + ' 条');
}
console.log('='.repeat(70));
console.log();
if (hit > 0 && miss === 0) {
  console.log('结论：sign 管线**正确**（T 与公式都对）');
  console.log('      → 417 不是 sign 造成的，去查请求头 / 设备标识');
} else if (hit > 0) {
  console.log('结论：sign 管线**部分正确**');
} else {
  console.log('结论：sign 管线**对不上真机**');
  console.log('      → T 生成 或 chainMd5 公式有问题，这才是 417 真因');
}
