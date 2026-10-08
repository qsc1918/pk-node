#!/usr/bin/env node
'use strict';
/**
 * PK 提交 400 的受控对照：用**真机原始 body** 直接发。
 *
 * ## 为什么这样做
 *   已排除：
 *     · body 结构 —— diff-pk-body.js 显示与真机样本**逐字段完全一致**
 *     · 时间间隔 —— 3s / 9s / 20s 三次全 400
 *   剩下的变量只有**请求形态**（URL 参数 / 请求头 / 编码）。
 *
 *   用真机样本的**原始 questions**（含真机自己的笔迹点数）重放，
 *   可以把「笔迹质量」这个因素也排掉。
 *
 * ## 变体（一次一个，避免混淆）
 *   ① 真机 body + 现有 URL/头          （基线）
 *   ② 真机 body + 去掉 isBackground 等（看参数影响）
 *   ③ 真机 body + 不同 content-type    （application/json 试试）
 *   ④ 现有 body（我们生成）+ 现有形态   （复现 400）
 *
 * 判据：谁从 400 变 200，就锁定是哪个变量。
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const leo = require(path.join(ROOT, 'src', 'leo'));
const engine = require(path.join(ROOT, 'src', 'pk-engine'));
const native = require(path.join(ROOT, 'src', 'native'));
const { config, PK } = require(path.join(ROOT, 'src', 'config'));
const { request } = require(path.join(ROOT, 'src', 'http'));

const ACC_ID = Number(process.argv[2] || 15);
const POINT_ID = Number(process.argv[3] || 1959);
const REAL = JSON.parse(fs.readFileSync('/root/alinker/pk_body.json', 'utf8'));

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

function qsOf(o) {
  return Object.keys(o).filter((k) => o[k] != null)
    .map((k) => k + '=' + encodeURIComponent(o[k])).join('&');
}

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号'); process.exit(1); }
  const jar = jobs.jarOf(acc);
  line('账号 id=' + acc.id + '  yfd_u=' + acc.yfd_u);

  // 出一次题，拿到**本账号有效**的 pkIdStr（真机样本的 pkIdStr 早过期）
  hr('出题');
  let m = null;
  for (let i = 0; i < 12; i++) {
    m = await leo.pkMatchV2(jar, POINT_ID, {});
    if (m.status === 200 && m.json) break;
    if (m.status !== 429 && m.status !== 400) { line('  出题失败 ' + m.status); process.exit(0); }
    line('  出题 ' + m.status + '，等 10s');
    await sleep(10000);
  }
  if (!m || m.status !== 200 || !m.json) { line('  出题不成功'); process.exit(0); }
  const pkIdStr = m.json.pkIdStr;
  const examVO = m.json.examVO || {};
  line('  pkIdStr = ' + pkIdStr + '  题数 = ' + ((examVO.questions || []).length));

  // 用真机的 questions，但换成本次的 pkIdStr/examId
  const realBody = JSON.parse(JSON.stringify(REAL));
  realBody.pkIdStr = pkIdStr;
  realBody.pointId = examVO.pointId == null ? REAL.pointId : examVO.pointId;
  realBody.pointName = examVO.pointName == null ? REAL.pointName : examVO.pointName;
  realBody.ruleType = examVO.ruleType == null ? REAL.ruleType : examVO.ruleType;
  realBody.questions = (realBody.questions || []).map((q) => Object.assign({}, q, { examId: Number(pkIdStr) }));

  const ourBody = engine.buildSubmitBody(m.json, { costTimeMs: 100, seedBase: 7, strokeMode: 'ARC' });

  const enc = (o) => native.encodeSubmitBody(Buffer.from(JSON.stringify(o), 'utf8'));

  const PK_PATH = '/leo-game-pk/android/math/pk/submit';
  const baseQ = Object.assign({}, PK.commonQuery, { _productId: '611' });

  const cases = [];

  // ① 真机 body + 现有形态
  cases.push({
    name: '① 真机 body + 现行形态',
    body: realBody, urlQ: baseQ, ct: 'application/octet-stream', referer: true,
  });

  // ② 真机 body + 去掉公共参数（只留 _productId）
  cases.push({
    name: '② 真机 body + 仅 _productId',
    body: realBody, urlQ: { _productId: '611' }, ct: 'application/octet-stream', referer: true,
  });

  // ③ 真机 body + application/json
  cases.push({
    name: '③ 真机 body + json CT',
    body: realBody, urlQ: baseQ, ct: 'application/json', referer: true,
  });

  // ④ 我们生成的 body（复现基线）
  cases.push({
    name: '④ 我们的 body + 现行形态',
    body: ourBody, urlQ: baseQ, ct: 'application/octet-stream', referer: true,
  });

  hr('受控提交');
  for (const c of cases) {
    const pathForSign = PK_PATH;
    const q = Object.assign({}, c.urlQ);
    const sign = native.calcSign(pathForSign, { version: q.version || PK.commonQuery.version });
    if (sign) q.sign = sign;
    const url = config.leoBase + pathForSign + '?' + qsOf(q);

    const headers = Object.assign(
      { 'Content-Type': c.ct },
      c.referer ? { Referer: config.leoBase + '/bh5/leo-web-oral-pk/pk.html' } : {},
      leo.riskHeaders(),
    );

    line('');
    line('  --- ' + c.name + ' ---');
    try {
      const r = await request({
        url, method: 'PUT', jar, body: enc(c.body), headers, timeoutMs: 25000,
      });
      const blk = (r.headers && (r.headers['x-block-by'] || r.headers['X-Block-By'])) || '-';
      const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
      line('    → ' + tag + '   x-block-by=' + blk);
      line('      ' + String(r.text || '').slice(0, 180).replace(/\s+/g, ' '));
    } catch (e) {
      line('    → 异常: ' + e.message);
    }
    await sleep(3200);
  }

  hr('判定');
  line('  ①=200 → 我们的 body 有问题（④ 应为 400，形成对照）');
  line('  ④=200 → 我们的形态其实可用，400 可能来自出题→提交的配对关系');
  line('  全 400 → 请求形态之外还有约束（需真机日志对比）');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });