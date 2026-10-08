#!/usr/bin/env node
'use strict';
/**
 * PK 提交体逐字段 diff：真机样本 vs 我们生成的 body。
 *
 * ## 已知
 *   PK 提交 400 与**时间无关**（3s/9s/20s 三次全 400）。
 *   所以差异一定在 **body 内容**。
 *
 * ## 本脚本
 *   真机样本：/root/alinker/pk_body.json（2026-09-27 采集，含完整 questions）
 *   我们的  ：engine.buildSubmitBody() 对同一结构生成的结果
 *
 *   逐字段比较：键集合、类型、值域。把"不一样"的地方全列出来。
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = '/root/pk-node';

const engine = require(path.join(ROOT, 'src', 'pk-engine'));

const REAL = JSON.parse(fs.readFileSync('/root/alinker/pk_body.json', 'utf8'));

/** 造一个和真机样本同构的「出题响应」，喂给 buildSubmitBody。 */
function fakeMatch(real) {
  const questions = (real.questions || []).map((q) => ({
    id: q.id,
    examId: q.examId,
    content: q.content,
    answer: q.answer,
    answers: q.answers,
    ruleType: q.ruleType,
    errorState: q.errorState,
  }));
  return {
    pkIdStr: real.pkIdStr,
    examVO: {
      pointId: real.pointId,
      pointName: real.pointName,
      ruleType: real.ruleType,
      questions: questions,
    },
  };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function line(s) { console.log(s); }

line('='.repeat(88));
line('【1】顶层字段对比');
line('='.repeat(88));
const ours = engine.buildSubmitBody(fakeMatch(REAL), { costTimeMs: 100, seedBase: 1, strokeMode: 'ARC' });

const realKeys = Object.keys(REAL);
const ourKeys = Object.keys(ours);
line('  真机键: ' + realKeys.join(', '));
line('  我们键: ' + ourKeys.join(', '));
const onlyReal = realKeys.filter((k) => !ourKeys.includes(k));
const onlyOurs = ourKeys.filter((k) => !realKeys.includes(k));
line('  仅真机有: ' + (onlyReal.length ? onlyReal.join(', ') : '（无）'));
line('  仅我们有: ' + (onlyOurs.length ? onlyOurs.join(', ') : '（无）'));
line('');
for (const k of realKeys) {
  if (k === 'questions') continue;
  const rv = REAL[k], ov = ours[k];
  const same = JSON.stringify(rv) === JSON.stringify(ov);
  line('  ' + (same ? '  ' : '⚠️') + ' ' + k.padEnd(14)
    + '真机=' + String(rv).slice(0, 34).padEnd(36)
    + '我们=' + String(ov).slice(0, 34));
}

line('');
line('='.repeat(88));
line('【2】question[0] 字段对比');
line('='.repeat(88));
const rq = REAL.questions[0];
const oq = ours.questions[0];
const rqk = Object.keys(rq), oqk = Object.keys(oq);
line('  真机键: ' + rqk.join(', '));
line('  我们键: ' + oqk.join(', '));
const onlyRq = rqk.filter((k) => !oqk.includes(k));
const onlyOq = oqk.filter((k) => !rqk.includes(k));
line('  仅真机有: ' + (onlyRq.length ? onlyRq.join(', ') : '（无）'));
line('  仅我们有: ' + (onlyOq.length ? onlyOq.join(', ') : '（无）'));
line('');
for (const k of rqk) {
  const rv = rq[k], ov = oq[k];
  const rt = typeOf(rv), ot = typeOf(ov);
  if (k === 'script' || k === 'curTrueAnswer') {
    line('  ' + (rt === ot ? '  ' : '⚠️') + ' ' + k.padEnd(15) + '类型 真机=' + rt + ' 我们=' + ot + '  (内容略)');
    continue;
  }
  const same = JSON.stringify(rv) === JSON.stringify(ov);
  line('  ' + (same ? '  ' : '⚠️') + ' ' + k.padEnd(15)
    + '类型 真机=' + rt.padEnd(7) + '我们=' + ot.padEnd(7)
    + ' 值 真机=' + String(rv).slice(0, 22).padEnd(24) + '我们=' + String(ov).slice(0, 22));
}

line('');
line('='.repeat(88));
line('【3】script 结构对比（真机是 JSON 字符串还是数组？）');
line('='.repeat(88));
line('  真机 script 类型: ' + typeOf(rq.script));
if (typeof rq.script === 'string') {
  try {
    const p = JSON.parse(rq.script);
    line('    可解析为 JSON，外层 ' + p.length + ' 笔，第 1 笔 ' + (p[0] || []).length + ' 点');
  } catch (e) { line('    不可解析: ' + e.message); }
}
line('  我们 script 类型: ' + typeOf(oq.script));
if (typeof oq.script === 'string') {
  try {
    const p = JSON.parse(oq.script);
    line('    可解析为 JSON，外层 ' + p.length + ' 笔，第 1 笔 ' + (p[0] || []).length + ' 点');
  } catch (e) { line('    不可解析: ' + e.message); }
}

line('');
line('='.repeat(88));
line('【4】curTrueAnswer 对比');
line('='.repeat(88));
const rcta = rq.curTrueAnswer || {};
const octa = oq.curTrueAnswer || {};
line('  真机键: ' + Object.keys(rcta).join(', '));
line('  我们键: ' + Object.keys(octa).join(', '));
for (const k of Object.keys(rcta)) {
  const same = JSON.stringify(rcta[k]) === JSON.stringify(octa[k]);
  if (k === 'pathPoints') {
    line('  ' + (typeOf(rcta[k]) === typeOf(octa[k]) ? '  ' : '⚠️') + ' ' + k
      + ' 类型 真机=' + typeOf(rcta[k]) + ' 我们=' + typeOf(octa[k]));
    continue;
  }
  line('  ' + (same ? '  ' : '⚠️') + ' ' + k.padEnd(24)
    + '真机=' + String(rcta[k]).slice(0, 24).padEnd(26) + '我们=' + String(octa[k]).slice(0, 24));
}