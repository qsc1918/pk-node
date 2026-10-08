#!/usr/bin/env node
'use strict';
/**
 * 验证 PK 提交 400 的真因是不是「时间间隔」（与练习同一机制）。
 *
 * ## 已知
 *   · PK 出题成功，**提交**返回 400 `{"status":400,"message":"error"}`
 *   · 提交体结构与真机样本（/root/alinker/pk_body.json）逐字段一致：
 *       script = JSON 字符串、curTrueAnswer = {recognizeResult, pathPoints,
 *       answer, showReductionFraction}、ruleType 透传、costTime 可控
 *     ⇒ 不是字段结构问题
 *   · PK 现有逻辑只等 submitDelayMin/Max = 8~12s
 *
 * ## 猜测
 *   练习那边刚证实：服务端要「出题→提交」有**绝对最小间隔**（约 1.5s）。
 *   PK 也许是同类机制但阈值更高（PK 是对局，服务端可能要求更长）。
 *
 * ## 做法
 *   一轮内连续提交多次，间隔递增：
 *     出题后 3s 提交 → 8s（若已递交会返「已提交」之类）→ 20s
 *   观察哪一次从 400 变 200。若一直 400，说明与时间无关，另找。
 *
 * ⚠️ 用 buildSubmitBody 产出与生产完全一致的 body（不手写）。
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const leo = require(path.join(ROOT, 'src', 'leo'));
const engine = require(path.join(ROOT, 'src', 'pk-engine'));
const native = require(path.join(ROOT, 'src', 'native'));

const ACC_ID = Number(process.argv[2] || 15);
const POINT_ID = Number(process.argv[3] || 1959);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 id=' + acc.id + '  yfd_u=' + acc.yfd_u + '  pointId=' + POINT_ID);

  hr('出题（pkMatchV2，带 429 重试）');
  let m = null;
  for (let i = 0; i < 12; i++) {
    m = await leo.pkMatchV2(jar, POINT_ID, {});
    if (m.status === 200 && m.json) break;
    if (m.status !== 429 && m.status !== 400) { line('  出题失败 ' + m.status + ': ' + String(m.text).slice(0, 110)); process.exit(0); }
    line('  出题 ' + m.status + '，等 10s（第 ' + (i + 1) + ' 次）');
    await sleep(10000);
  }
  if (!m || m.status !== 200 || !m.json) { line('  出题始终不成功，稍后再试'); process.exit(0); }
  const pkIdStr = m.json.pkIdStr;
  const qs = (m.json.examVO && m.json.examVO.questions) || [];
  line('  pkIdStr = ' + pkIdStr + '  题数 = ' + qs.length + '  pointId = ' + (m.json.examVO && m.json.examVO.pointId));

  const t0 = Date.now();
  let attempt = 0;
  for (const gap of [3000, 9000, 20000]) {
    const wait = gap - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    attempt++;

    let bodyObj;
    try {
      bodyObj = engine.buildSubmitBody(m.json, { costTimeMs: 100, seedBase: Date.now() % 1e9 + attempt, strokeMode: 'ARC' });
    } catch (e) {
      line('  组装 body 失败: ' + e.message);
      break;
    }
    let cipher;
    try {
      cipher = native.encodeSubmitBody(Buffer.from(JSON.stringify(bodyObj), 'utf8'));
    } catch (e) {
      line('  编码失败: ' + e.message);
      break;
    }
    const actual = Date.now() - t0;
    const s = await leo.pkSubmitRaw(jar, cipher, {});
    const tag = s.status === 200 ? '✅ 200' : ('❌ ' + s.status);
    line('  第 ' + attempt + ' 次 间隔 ' + (actual / 1000).toFixed(1) + 's  costTime=' + bodyObj.costTime
      + '  → ' + tag);
    line('      ' + String(s.text || '').slice(0, 160).replace(/\s+/g, ' '));
    if (s.status === 200) break;
  }

  hr('判定');
  line('  某次变 200 → PK 400 也是时间间隔问题，据此设等待即可。');
  line('  一直 400   → 与时间无关，需比对 body 的其它差异（ruleType/字段值等）。');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });