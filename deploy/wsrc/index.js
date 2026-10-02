// pk-node Worker 入口。
//
// 职责：
//   - HTTP 接口：登录（存 cookie）/ 手动跑一轮 / 看状态与日志
//   - cron：按计划自动跑（默认关闭，用 KV 开关控制）
//
// 存储（KV）：
//   acct:<id>  → { id, name, cookie, shepherdDid }
//   accts      → [id, ...]
//   log        → 最近的运行日志（数组，保留 100 条）
//   state      → { autoRun, lastRunAt, rounds }

import { PATH } from './signcfg.js';
import { pkMatchV2, pkSubmit, pkHistoryDetail, buildSubmitBody, isRateLimited } from './pk.js';
import { calcT } from './emu.js';
import { chainMd5 } from './sign.js';
import { encodeBody, decodeBody } from './codec.js';
import { buildPathPoints, STROKE_MODES } from './strokes.js';

const MAX_LOG = 100;

// ---------------------------------------------------------------- KV helpers

async function getJson(env, key, def) {
  const v = await env.KV.get(key, 'json');
  return v == null ? def : v;
}

async function pushLog(env, line) {
  const logs = await getJson(env, 'log', []);
  logs.unshift({ at: new Date().toISOString(), line: line });
  if (logs.length > MAX_LOG) logs.length = MAX_LOG;
  await env.KV.put('log', JSON.stringify(logs));
}

// ---------------------------------------------------------------- 业务

/**
 * 跑一轮 PK：出题 → 提交 → 结算核对。
 * @returns {Promise<object>} 结果（含各阶段耗时，便于观察 CPU 预算）
 */
export async function runOneRound(env, acct, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const out = { ok: false, stages: {} };
  const shepherdDid = acct.shepherdDid || env.PK_SHEPHERD_DID || '';

  // 1) 出题
  let m;
  try {
    m = await pkMatchV2(acct, o.pointId || 64, shepherdDid);
  } catch (e) {
    out.error = '出题异常：' + e.message;
    return out;
  }
  out.stages.matchMs = Date.now() - t0;
  out.matchStatus = m.status;
  if (m.status !== 200 || !m.json) {
    out.error = '出题失败 HTTP ' + m.status;
    out.rateLimited = isRateLimited(m.status, m.json);
    return out;
  }
  const pkIdStr = m.json.pkIdStr;
  out.pkIdStr = pkIdStr;

  // 2) 组装提交体 + 提交
  let bodyObj;
  try {
    bodyObj = buildSubmitBody(m.json, { pointId: o.pointId || 64, strokeMode: o.strokeMode || STROKE_MODES.ARC });
  } catch (e) {
    out.error = '组装提交体失败：' + e.message;
    return out;
  }
  out.questionCnt = bodyObj.questionCnt;
  out.stages.buildMs = Date.now() - t0 - (out.stages.matchMs || 0);

  const r1raw = await pkSubmit(acct, bodyObj, shepherdDid);
  out.submitStatus = r1raw.status;
  let r1 = r1raw;

  // ★ 提交接口有**独立频控**（403）：与本机 pk-node 一致，退避后重试。
  //   退避用 setTimeout 等待——**等待不计 CPU**，所以免费层也能扛。
  if (r1.status === 403 && o.retry !== false) {
    const maxTry = o.maxSubmitRetry == null ? 2 : o.maxSubmitRetry;
    for (let attempt = 1; attempt <= maxTry && r1.status === 403; attempt++) {
      const waitMs = (o.rateLimitBaseMs == null ? 10000 : o.rateLimitBaseMs) * attempt;
      await new Promise((res) => setTimeout(res, waitMs));
      r1 = await pkSubmit(acct, bodyObj, shepherdDid);
      out.submitStatus = r1.status;
      out.submitRetries = attempt;
    }
  }

  out.stages.submitMs = Date.now() - t0 - (out.stages.matchMs || 0) - (out.stages.buildMs || 0);
  if (r1.status !== 200) {
    out.error = '提交失败 HTTP ' + r1.status;
    out.rateLimited = isRateLimited(r1.status, r1.json);
    return out;
  }

  // 3) 结算核对
  let d = null;
  try {
    d = await pkHistoryDetail(acct, pkIdStr, shepherdDid);
  } catch (e) { /* 结算核对失败不影响「提交成功」的判定 */ }
  out.settleStatus = d ? d.status : null;
  out.settled = d && d.status === 200 ? d.json : null;
  out.stages.settleMs = Date.now() - t0 - (out.stages.matchMs || 0) - (out.stages.buildMs || 0) - (out.stages.submitMs || 0);
  out.stages.totalMs = Date.now() - t0;
  out.ok = true;
  return out;
}

// ---------------------------------------------------------------- HTTP

function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const PAGE = (body) => new Response(
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>pk-node (cloudflare)</title>'
  + '<style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;max-width:820px;margin:24px auto;padding:0 16px}'
  + 'code{background:#f2f2f2;padding:1px 4px;border-radius:3px}pre{background:#f7f7f7;padding:10px;border-radius:6px;overflow:auto}'
  + 'button{padding:8px 14px;margin:4px 6px 4px 0;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer}'
  + 'input{width:100%;padding:8px;box-sizing:border-box;margin:4px 0;border:1px solid #ccc;border-radius:6px}'
  + '.ok{color:#137333}.err{color:#c5221f}</style>'
  + body,
  { headers: { 'content-type': 'text/html; charset=utf-8' } },
);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/' || p === '/index.html') {
      const accts = await getJson(env, 'accts', []);
      const logs = await getJson(env, 'log', []);
      const state = await getJson(env, 'state', { autoRun: false, rounds: 0 });
      const rows = [];
      for (const id of accts) {
        const a = await getJson(env, 'acct:' + id, null);
        if (a) rows.push('<li><code>' + id + '</code> ' + (a.name || '-') + '</li>');
      }
      return PAGE(
        '<h2>pk-node（Cloudflare Worker 版）</h2>'
        + '<p>账号：' + (rows.length ? '<ul>' + rows.join('') + '</ul>' : '<i>还没有账号</i>') + '</p>'
        + '<p>自动跑：<b>' + (state.autoRun ? '已开启' : '已关闭') + '</b>　累计轮数：' + (state.rounds || 0) + '</p>'
        + '<h3>添加账号</h3>'
        + '<p>粘贴小猿口算的 Cookie（从浏览器开发者工具复制 request 里的 Cookie 头）：</p>'
        + '<form method="post" action="/api/login">'
        + '<input name="name" placeholder="备注名（可空）">'
        + '<input name="cookie" placeholder="Cookie（必须含 sess / sid / userid 等）">'
        + '<input name="shepherdDid" placeholder="x-shepherd-did（可空）">'
        + '<button type="submit">保存</button></form>'
        + '<h3>操作</h3>'
        + '<form method="post" action="/api/run"><button type="submit">立即跑一轮</button></form>'
        + '<form method="post" action="/api/autorun">'
        + '<button type="submit">' + (state.autoRun ? '关闭自动跑' : '开启自动跑') + '</button></form>'
        + '<h3>最近日志</h3><pre>' + (logs.length ? logs.slice(0, 30).map((x) => x.at + '  ' + x.line).join('\n') : '(空)') + '</pre>',
      );
    }

    // 保存账号
    if (p === '/api/login' && request.method === 'POST') {
      const form = await request.formData();
      const cookie = String(form.get('cookie') || '').trim();
      const name = String(form.get('name') || '').trim() || '账号';
      const shepherdDid = String(form.get('shepherdDid') || '').trim();
      if (!cookie) return json({ ok: false, message: 'cookie 不能为空' }, 400);
      const id = 'a' + Date.now().toString(36);
      await env.KV.put('acct:' + id, JSON.stringify({ id: id, name: name, cookie: cookie, shepherdDid: shepherdDid }));
      const accts = await getJson(env, 'accts', []);
      accts.push(id);
      await env.KV.put('accts', JSON.stringify(accts));
      await pushLog(env, '已添加账号 ' + name);
      return Response.redirect(new URL('/', url).toString(), 303);
    }

    // 立即跑一轮
    if (p === '/api/run' && request.method === 'POST') {
      const accts = await getJson(env, 'accts', []);
      if (!accts.length) return json({ ok: false, message: '还没有账号' }, 400);
      const a = await getJson(env, 'acct:' + accts[0], null);
      const r = await runOneRound(env, a, {});
      await pushLog(env, (r.ok ? '✅ 一轮成功' : '❌ 一轮失败') + ' ' + JSON.stringify(r.stages)
        + (r.error ? ' ' + r.error : '') + (r.pkIdStr ? ' pk=' + r.pkIdStr : ''));
      if (request.headers.get('accept') && request.headers.get('accept').indexOf('text/html') >= 0) {
        return Response.redirect(new URL('/', url).toString(), 303);
      }
      return json(r);
    }

    // 自动跑开关
    if (p === '/api/autorun' && request.method === 'POST') {
      const state = await getJson(env, 'state', { autoRun: false, rounds: 0 });
      state.autoRun = !state.autoRun;
      await env.KV.put('state', JSON.stringify(state));
      await pushLog(env, '自动跑已' + (state.autoRun ? '开启' : '关闭'));
      return Response.redirect(new URL('/', url).toString(), 303);
    }

    if (p === '/api/status') {
      const accts = await getJson(env, 'accts', []);
      const state = await getJson(env, 'state', { autoRun: false, rounds: 0 });
      const list = [];
      for (const id of accts) {
        const a = await getJson(env, 'acct:' + id, null);
        if (a) list.push({ id: a.id, name: a.name, hasShepherdDid: !!a.shepherdDid });
      }
      return json({ ok: true, accounts: list, state: state });
    }

    if (p === '/api/log') {
      return json({ ok: true, log: await getJson(env, 'log', []) });
    }

    // 诊断：算一次 sign 并报告耗时（用于确认免费层 CPU 预算）
    if (p === '/api/selftest') {
      const t0 = Date.now();
      const minute = Math.floor(Date.now() / 60000);
      const T = calcT(minute * 60, 'pk');
      const t1 = Date.now();
      const sign = chainMd5(PATH.submit, T);
      const t2 = Date.now();
      const strokes = buildPathPoints('>', 42, STROKE_MODES.ARC);
      const t3 = Date.now();
      const enc = await encodeBody({ hello: 'world', n: 123 });
      const t4 = Date.now();
      const dec = await decodeBody(enc);
      const t5 = Date.now();
      return json({
        ok: true,
        sign: sign,
        tLen: T.length,
        strokePoints: strokes.strokes.length ? strokes.strokes[0].length : 0,
        encodedLen: enc.length,
        roundTripOk: !!(dec && dec.hello === 'world'),
        ms: { calcT: t1 - t0, chainMd5: t2 - t1, strokes: t3 - t2, encode: t4 - t3, decode: t5 - t4, total: t5 - t0 },
      });
    }

    return json({ ok: false, message: '未知路径 ' + p }, 404);
  },

  /** cron 触发：若开关打开，就跑一轮。 */
  async scheduled(event, env, ctx) {
    // ⚠️ 无论成败都先写一条 KV：这样能精确区分
    //   「cron 根本没触发」和「触发了但业务失败」——排查时非常关键。
    const stamp = new Date().toISOString();
    try {
      await env.KV.put('lastCron', stamp);

      const state = await getJson(env, 'state', { autoRun: false, rounds: 0 });
      if (!state.autoRun) {
        await env.KV.put('lastCronNote', stamp + ' autoRun=off');
        return;
      }
      const accts = await getJson(env, 'accts', []);
      if (!accts.length) {
        await env.KV.put('lastCronNote', stamp + ' 无账号');
        return;
      }
      const a = await getJson(env, 'acct:' + accts[0], null);
      const r = await runOneRound(env, a, {});
      state.rounds = (state.rounds || 0) + (r.ok ? 1 : 0);
      state.lastRunAt = stamp;
      await env.KV.put('state', JSON.stringify(state));
      await pushLog(env, '[cron] ' + (r.ok ? '✅ 成功' : '❌ 失败') + ' ' + JSON.stringify(r.stages)
        + (r.error ? ' ' + r.error : ''));
      await env.KV.put('lastCronNote', stamp + ' ' + (r.ok ? 'ok' : 'fail: ' + (r.error || '')));
    } catch (e) {
      await env.KV.put('lastCronError', stamp + ' ' + String((e && e.message) || e));
    }
  },
};