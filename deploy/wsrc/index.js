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
import { addLog, recentLogs, trimLogs } from './db.js';

const MAX_LOG = 300;

// ---------------------------------------------------------------- 存储

/**
 * 读取「账号列表」等小配置：仍走 KV（读很便宜，免费层 10 万次/天）。
 *
 * ⚠️ 但**写入**必须省着用：KV 免费层只有 **1000 次写/天**，
 * 线上曾因自动跑频繁写日志把额度耗尽 → 所有写操作报
 * `KV put() limit exceeded for the day.`。
 * 所以：账号/开关这类「用户主动操作」才写 KV；**运行日志一律写 D1**。
 */
async function getJson(env, key, def) {
  const v = await env.KV.get(key, 'json');
  return v == null ? def : v;
}

/** 运行日志 → D1（额度 10 万行/天，比 KV 高两个数量级）。 */
async function pushLog(env, line) {
  try {
    await addLog(env.DB, line);
    // 偶尔修剪，避免无限增长（失败不影响主流程）
    if (Math.random() < 0.1) await trimLogs(env.DB, MAX_LOG);
  } catch (e) {
    // 日志写失败绝不能影响业务
  }
}

/**
 * 计数器的「省写」策略：把 rounds/lastRunAt 记在内存里，
 * 只在**每 20 轮**或显式需要时才落 KV —— 避免把 1000 次/天的写额度耗光。
 */
let memState = null;
let roundsSinceFlush = 0;

async function loadState(env) {
  if (memState) return memState;
  memState = await getJson(env, 'state', { autoRun: false, rounds: 0, lastRunAt: null });
  return memState;
}

async function bumpRounds(env, ok) {
  const st = await loadState(env);
  if (ok) st.rounds = (st.rounds || 0) + 1;
  st.lastRunAt = new Date().toISOString();
  roundsSinceFlush++;
  if (roundsSinceFlush >= 20) {
    roundsSinceFlush = 0;
    try { await env.KV.put('state', JSON.stringify(st)); } catch (e) { /* 额度问题不致命 */ }
  }
}

async function saveState(env) {
  const st = await loadState(env);
  roundsSinceFlush = 0;
  try { await env.KV.put('state', JSON.stringify(st)); } catch (e) { /* ignore */ }
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
  /**
   * 全局异常兜底：把真实错误写进响应体。
   * 没有它的话，Cloudflare 只返回一个笼统的 “Worker threw exception”（1101），
   * 完全看不到是哪一行炸的（这次排查 POST /api/run 就卡在这）。
   */
  async fetch(request, env, ctx) {
    try {
      return await this.handle(request, env, ctx);
    } catch (e) {
      return new Response(JSON.stringify({
        ok: false,
        layer: 'worker',
        message: String((e && e.message) || e),
        stack: String((e && e.stack) || '').split('\n').slice(0, 8),
        path: new URL(request.url).pathname,
        method: request.method,
      }, null, 2), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  },

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/' || p === '/index.html') {
      const accts = await getJson(env, 'accts', []);
      const logs = await recentLogs(env.DB, 30);
      const state = await loadState(env);
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
        + '<h3>最近日志</h3><pre>' + (logs.length ? logs.map((x) => x.at + '  ' + x.line).join('\n') : '(空)') + '</pre>',
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
      await bumpRounds(env, r.ok);
      if (request.headers.get('accept') && request.headers.get('accept').indexOf('text/html') >= 0) {
        return Response.redirect(new URL('/', url).toString(), 303);
      }
      return json(r);
    }

    // 自动跑开关
    if (p === '/api/autorun' && request.method === 'POST') {
      const state = await loadState(env);
      state.autoRun = !state.autoRun;
      await saveState(env);
      await pushLog(env, '自动跑已' + (state.autoRun ? '开启' : '关闭'));
      return Response.redirect(new URL('/', url).toString(), 303);
    }

    if (p === '/api/status') {
      const accts = await getJson(env, 'accts', []);
      const state = await loadState(env);
      const list = [];
      for (const id of accts) {
        const a = await getJson(env, 'acct:' + id, null);
        if (a) list.push({ id: a.id, name: a.name, hasShepherdDid: !!a.shepherdDid });
      }
      return json({ ok: true, accounts: list, state: state });
    }

    // ★ 外部定时触发入口（给 GitHub Actions / cron-job.org 这类外部调度器用）。
    //
    // 为什么需要它：实测该账号的 Cloudflare 原生 cron **不执行**（详见 README/提交说明），
    // 所以用外部调度器定时打这个端点来驱动「跑一轮」。
    // 鉴权：`X-Token` 必须等于 secret TRIGGER_TOKEN（未配置时该端点禁用）。
    if (p === '/api/tick') {
      const need = env.TRIGGER_TOKEN;
      if (!need) return json({ ok: false, message: '未配置 TRIGGER_TOKEN，/api/tick 已禁用' }, 403);
      const got = request.headers.get('X-Token') || url.searchParams.get('token') || '';
      if (got !== need) return json({ ok: false, message: 'token 不对' }, 403);

      const state = await loadState(env);
      const stamp = new Date().toISOString();
      // ⚠️ 不写 KV：/api/tick 每 10 分钟触发一次，写 KV 会把免费层
      //    **1000 次写/天** 的额度耗光（线上曾因此全线 500）。
      if (!state.autoRun) {
        return json({ ok: true, skipped: 'autoRun 关闭', at: stamp });
      }
      const accts = await getJson(env, 'accts', []);
      if (!accts.length) return json({ ok: true, skipped: '没有账号', at: stamp });

      const a = await getJson(env, 'acct:' + accts[0], null);
      const r = await runOneRound(env, a, {});
      await bumpRounds(env, r.ok);
      await pushLog(env, '[tick] ' + (r.ok ? '✅ 成功' : '❌ 失败') + ' ' + JSON.stringify(r.stages)
        + (r.error ? ' ' + r.error : ''));

      // 返回完整结果：外部调度器的日志里就能直接看到成败与耗时
      return json({ ok: r.ok, at: stamp, result: r });
    }

    if (p === '/api/log') {
      return json({ ok: true, log: await recentLogs(env.DB, 100) });
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
    const stamp = new Date().toISOString();
    try {
      const state = await loadState(env);
      if (!state.autoRun) {
        await pushLog(env, '[cron] autoRun 关闭 ' + stamp);
        return;
      }
      const accts = await getJson(env, 'accts', []);
      if (!accts.length) {
        await pushLog(env, '[cron] 无账号 ' + stamp);
        return;
      }
      const a = await getJson(env, 'acct:' + accts[0], null);
      const r = await runOneRound(env, a, {});
      await bumpRounds(env, r.ok);
      await pushLog(env, '[cron] ' + (r.ok ? '✅ 成功' : '❌ 失败') + ' ' + JSON.stringify(r.stages)
        + (r.error ? ' ' + r.error : ''));
    } catch (e) {
      await pushLog(env, '[cron] 异常 ' + stamp + ' ' + String((e && e.message) || e));
    }
  },
};