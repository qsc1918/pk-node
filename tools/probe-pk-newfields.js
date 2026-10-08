#!/usr/bin/env node
'use strict';
/**
 * 验证：PK 提交体加上「对局字段」后能否 200。
 *
 * ## 新增证据（tools/dump-pk-response.js）
 *   服务端 PK 出题响应里有**对局字段**，而我们提交时全丢了：
 *
 *     targetCostTime = 84138   ← 对局目标用时（84s），不是我们能随便填的
 *     otherUser      = {…}     ← 真实对手（墨颜）
 *     selfWinCount / otherWinCount
 *     extra
 *     examVO.updatedTime / examVO.triggerPeakMatch
 *
 *   09-27 的真机样本里**没有**这些（旧版服务端），所以照着它写的
 *   `buildSubmitBody` 在 3.141.1 下就缺字段 → 400 `error`。
 *
 * ## 本脚本
 *   逐一叠加这些字段，看哪一步变 200：
 *     ① 基线（现行 buildSubmitBody）
 *     ② + targetCostTime（costTime 也改成它）
 *     ③ + targetCostTime + otherUser/selfWinCount/otherWinCount/extra
 *     ④ + 全套（再把 examVO 的 updatedTime/triggerPeakMatch 也带上）
 *
 * ⚠️ 每步之间等 1.2s，且都走**同一个 exam**（避免 429）。
 */
const fs = require('node:fs');
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

  hr('出题');
  let m = null;
  for (let i = 0; i < 12; i++) {
    m = await leo.pkMatchV2(jar, POINT_ID, {});
    if (m.status === 200 && m.json) break;
    if (m.status !== 429 && m.status !== 400) { line('  出题失败 ' + m.status); process.exit(0); }
    line('  ' + m.status + '，等 10s');
    await sleep(10000);
  }
  if (!m || m.status !== 200 || !m.json) { line('  出题不成功'); process.exit(0); }

  const root = m.json;
  const ev = root.examVO || {};
  line('  pkIdStr = ' + root.pkIdStr);
  line('  targetCostTime = ' + root.targetCostTime + '   otherUser = ' + JSON.stringify(root.otherUser || null).slice(0, 60));
  line('  updatedTime = ' + ev.updatedTime + '   triggerPeakMatch = ' + ev.triggerPeakMatch);

  const tMatch = Date.now();
  const targetCost = Number(root.targetCostTime) || 0;

  const build = (extra, costMs) => {
    const b = engine.buildSubmitBody(root, { costTimeMs: costMs == null ? 100 : costMs, seedBase: Date.now() % 1e9, strokeMode: 'ARC' });
    return Object.assign(b, extra || {});
  };

  const cases = [
    { name: '① 基线（现行）', mk: () => build({}, 100) },
    { name: '② + targetCostTime（costTime=它）', mk: () => build({ targetCostTime: targetCost }, targetCost) },
    {
      name: '③ + 对手/胜场/extra',
      mk: () => build({
        targetCostTime: targetCost,
        otherUser: root.otherUser,
        selfWinCount: root.selfWinCount,
        otherWinCount: root.otherWinCount,
        extra: root.extra,
      }, targetCost),
    },
    {
      name: '④ + 全套（再带 updatedTime/triggerPeakMatch）',
      mk: () => build({
        targetCostTime: targetCost,
        otherUser: root.otherUser,
        selfWinCount: root.selfWinCount,
        otherWinCount: root.otherWinCount,
        extra: root.extra,
        updatedTime: ev.updatedTime,
        triggerPeakMatch: ev.triggerPeakMatch,
      }, targetCost),
    },
  ];

  hr('逐组提交');
  for (const c of cases) {
    // 保持「出题→提交 ≥ 2.5s」
    const wait = 2500 - (Date.now() - tMatch);
    if (wait > 0) await sleep(wait);

    const body = c.mk();
    let cipher;
    try {
      cipher = native.encodeSubmitBody(Buffer.from(JSON.stringify(body), 'utf8'));
    } catch (e) { line('  ' + c.name + ' → 编码失败: ' + e.message); continue; }

    const s = await leo.pkSubmitRaw(jar, cipher, {});
    const tag = s.status === 200 ? '✅ 200' : ('❌ ' + s.status);
    line('  ' + c.name.padEnd(38) + ' → ' + tag);
    if (s.status !== 200) {
      line('      ' + String(s.text || '').slice(0, 150).replace(/\s+/g, ' '));
    } else {
      line('      ✅ 成功！这一组就是正解。');
      break;
    }
    await sleep(1200);
  }

  hr('判定');
  line('  哪一组 200 → 那组补充的字段就是 3.141.1 新增的必需项。');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });