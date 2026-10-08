#!/usr/bin/env node
'use strict';
/**
 * PK 链路端到端探针 —— 看「PK 也跟着修」修到哪一步。
 *
 * ## 为什么需要
 *   `tools/decide-pk-variant.js` 已证明 **两个 variant 都能拿到 200**
 *   （`pk/home` 端点不校验 sign 差异）。所以要往下走**真正的对局链路**：
 *
 *     ① GET  game/battle/v2/math/home    活动主页
 *     ② WS   game/match/v2               匹配
 *     ③ WS   game/battle/v2              对局
 *     ④ PUT  math/pk/submit              提交
 *
 *   逐一实测，把「哪一步开始挂」定位出来。
 *
 * ## 用法
 *   node tools/probe-pk-chain.js [账号id]
 */
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const schoolSeason = require(path.join(ROOT, 'src', 'school-season'));
const pkEngine = require(path.join(ROOT, 'src', 'pk-engine'));

const ACC_ID = Number(process.argv[2] || 15);

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(84)); if (t) line(t); line('='.repeat(84)); }

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) { line('找不到账号 ' + ACC_ID); process.exit(1); }
  const jar = jobs.jarOf(acc);

  hr('账号');
  line('  id=' + acc.id + '  name=' + (acc.name || '-') + '  yfd_u=' + acc.yfd_u);

  // ---- ① 活动主页 ----
  hr('① GET game/battle/v2/math/home');
  try {
    const r = await schoolSeason.home(jar, {});
    line('  HTTP ' + (r && r.status));
    line('  body: ' + String((r && (r.text || JSON.stringify(r.json))) || '').slice(0, 400).replace(/\s+/g, ' '));
  } catch (e) {
    line('  异常: ' + e.message);
  }

  // ---- ② 榜单（pointId 从 ① 的返回值里取）----
  hr('② GET game/battle/v2/math/rank（用真实 pointId）');
  let pointId = null;
  try {
    const h = await schoolSeason.home(jar, {});
    const pts = (h && h.json && h.json.points) || [];
    if (pts.length) {
      pointId = pts[0].pointId;
      line('  从 home 取到 pointId=' + pointId + '  (' + (pts[0].pointName || '') + ')');
      line('  home 提供的全部 pointId: ' + pts.map((p) => p.pointId).join(', '));
    }
    const r = await schoolSeason.rank(jar, { pointId: pointId, scope: 1 });
    line('  HTTP ' + (r && r.status));
    line('  body: ' + String((r && (r.text || JSON.stringify(r.json))) || '').slice(0, 300).replace(/\s+/g, ' '));
  } catch (e) {
    line('  异常: ' + e.message);
  }

  // ---- ③ PK 出题（用真实 pointId）----
  hr('③ POST math/pk/match（PK 出题，真实 pointId）');
  try {
    const leo = require(path.join(ROOT, 'src', 'leo'));
    const r = await leo.pkMatch(jar, pointId || 2005, {});
    line('  HTTP ' + (r && r.status));
    line('  body: ' + String((r && (r.text || '')) || '').slice(0, 400).replace(/\s+/g, ' '));
    if (r && r.status === 200 && r.json) {
      const j = r.json;
      line('  examId/idString = ' + (j.idString || j.examId || '-'));
      line('  题数 = ' + ((j.questions && j.questions.length) || (j.examVO && j.examVO.questions && j.examVO.questions.length) || '-'));
    }
  } catch (e) {
    line('  异常: ' + e.message);
  }

  // ---- ④ 出题 v2（加密响应）----
  hr('④ POST math/pk/match/v2（加密响应）');
  try {
    const leo = require(path.join(ROOT, 'src', 'leo'));
    const r = await leo.pkMatchV2(jar, pointId || 2005, {});
    line('  HTTP ' + (r && r.status));
    line('  body 长度 = ' + String((r && r.text) || '').length);
    line('  body 前 200: ' + String((r && r.text) || '').slice(0, 200).replace(/\s+/g, ' '));
  } catch (e) {
    line('  异常: ' + e.message);
  }

  hr('汇总');
  line('  上面每步的 HTTP 码就是结论：');
  line('    · 200 → 该步正常');
  line('    · 417 → sign 校验失败');
  line('    · 401/403 → 登录态/风控');
  line('    · 4xx 其它 → 参数或路径问题');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });