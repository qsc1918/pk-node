#!/usr/bin/env node
'use strict';
/**
 * 从真机日志里**解码**练习提交的密文 body，取出真正的明文（含 script 格式）。
 *
 * ## 为什么能解
 *   真机提交体是二进制密文（日志里 `body=˲��)�k...`）。但编码链路是可逆的：
 *       cipher = XOR( gzip( plain ) )
 *   XOR 对称，且我们有同一套 keystream 资产 → 直接反算。
 *
 * ## 价值
 *   这是**唯一**能拿到「真机练习提交明文」的途径（原生日志只记密文），
 *   而隔离实验已证明 400 的元凶就在 script 字段。拿到真机格式即可定论。
 */
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const ROOT = '/root/pk-node';

const keystream = require(path.join(ROOT, 'src', 'keystream'));

const LOG = process.argv[2] || '/sdcard/Download/leo-logs/auto_oral-2026-10-01.log';
const KEYWORD = process.argv[3] || '/leo-math/android/exams/v2/';

function line(s) { console.log(s); }

const raw = fs.readFileSync(LOG);
const s = raw.toString('latin1');

line('日志 ' + LOG + '  字节 ' + raw.length);
line('keystream.available() = ' + keystream.available());

/** 找出所有「KEYWORD ... body=<密文>」片段。 */
function extract(keyword) {
  const out = [];
  let idx = 0;
  for (;;) {
    const k = s.indexOf(keyword, idx);
    if (k < 0) break;
    idx = k + keyword.length;
    const b = s.indexOf('body=', k);
    if (b < 0) continue;
    // 条目结束：下一个时间戳行 或 下一个 [PKT]
    let end1 = s.indexOf('\n2026-', b);
    let end2 = s.indexOf('\n[PKT]', b);
    let end = s.length;
    if (end1 >= 0) end = Math.min(end, end1);
    if (end2 >= 0) end = Math.min(end, end2);
    const chunk = s.slice(b + 5, end);
    if (chunk.length > 20) out.push(chunk);
  }
  return out;
}

const bodies = extract(KEYWORD);
line('找到带 body 的请求: ' + bodies.length + ' 个');

let okCount = 0;
bodies.forEach((chunk, i) => {
  line('');
  line('--- 第 ' + (i + 1) + ' 个（原始 ' + chunk.length + ' 字节）---');
  let buf;
  try {
    buf = Buffer.from(chunk, 'latin1');
  } catch (e) {
    line('  转 Buffer 失败: ' + e.message);
    return;
  }
  line('  前 24 字节 hex: ' + buf.slice(0, 24).toString('hex'));

  let dec;
  try {
    dec = keystream.xorEncode(buf);
  } catch (e) {
    line('  XOR 失败: ' + e.message);
    return;
  }
  line('  XOR 后前 4 字节: ' + dec.slice(0, 4).toString('hex') + '（gzip 魔数应为 1f8b）');

  let plain = null;
  if (dec[0] === 0x1f && dec[1] === 0x8b) {
    try { plain = zlib.gunzipSync(dec); } catch (e) { line('  gunzip 失败: ' + e.message); }
  } else if (dec[0] === 0x7b) {
    plain = dec;
  }
  if (!plain) { line('  不是 gzip/JSON，无法解出明文'); return; }

  okCount++;
  line('  ✅ 解出明文 ' + plain.length + ' 字节');
  let json = null;
  try { json = JSON.parse(plain.toString('utf8')); } catch (e) {
    line('  JSON 解析失败: ' + e.message);
    line('  原文前 300: ' + plain.toString('utf8').slice(0, 300));
    return;
  }

  line('  顶层键: ' + Object.keys(json).join(', '));
  line('  questionCnt=' + json.questionCnt + ' correctCnt=' + json.correctCnt
    + ' costTime=' + json.costTime + ' ruleType=' + json.ruleType);
  const qs = json.questions || [];
  line('  题数 ' + qs.length);
  if (qs[0]) {
    const q = qs[0];
    line('  question[0] 键: ' + Object.keys(q).join(', '));
    line('    id=' + q.id + ' examId=' + q.examId + ' ruleType=' + q.ruleType
      + ' status=' + q.status + ' costTime=' + q.costTime);
    line('    answer=' + JSON.stringify(q.answer) + ' userAnswer=' + JSON.stringify(q.userAnswer));
    const sc = q.script;
    line('    script 类型: ' + (sc === null ? 'null' : (Array.isArray(sc) ? 'array' : typeof sc))
      + (typeof sc === 'string' ? '  长度 ' + sc.length : ''));
    if (typeof sc === 'string') {
      line('    script 前 300: ' + sc.slice(0, 300));
      try {
        const p = JSON.parse(sc);
        line('    解析为: ' + (Array.isArray(p) ? ('数组 ' + p.length + ' 项') : typeof p));
        if (Array.isArray(p) && p[0] && typeof p[0] === 'object') {
          line('    第 0 项键: ' + Object.keys(p[0]).join(', '));
          line('    第 0 项样例: ' + JSON.stringify(p[0]).slice(0, 260));
        }
      } catch (e) { line('    不是合法 JSON: ' + e.message); }
    }
    line('    wrongScript 类型: ' + (q.wrongScript === null ? 'null' : typeof q.wrongScript));
  }
});

line('');
line('成功解出 ' + okCount + ' / ' + bodies.length + ' 个');
line('（注：真机练习提交本身大多是 400 —— 那是 10-01 当时的服务端行为，');
line('  但 body 的**结构**是权威的，正是我们要的 script 格式）');