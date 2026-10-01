'use strict';
// 任务调度器：串行跑刷局任务，支持停止；每轮结果落库 + 内存事件流。
//
// ## 为什么串行
//
// 提交接口有**独立频控**（403，窗口约十分钟级）。并发提交只会把所有请求
// 一起打进频控窗口，反而更慢且更容易被风控标记。所以这里刻意串行：
// 同一时刻最多一个任务在跑，任务内部一轮一轮来。
//
// ## 停止语义
//
// `stop(jobId)` 置一个内存标志 + 落库状态；正在 `await` 的轮次结束后
// 下一轮开始前检查标志并退出。不强行中断在途 HTTP（中断会导致状态不确定）。

const db = require('./db');
const leo = require('./leo');
const leoAccounts = require('./services/leo-accounts');
const engine = require('./pk-engine');
const exercise = require('./exercise');
const { config } = require('./config');

/**
 * 默认最大并行任务数。
 *
 * ★ 2026-10-01：改为 **0 = 不限制**（用户要求解除「最多 3 个」的限制）。
 * 仍可用 `PK_MAX_CONCURRENT=<正整数>` 设上限。
 */
const MAX_CONCURRENT = 0;

/** 运行中的任务表：jobId → { stopped:boolean, jar, config } */
const running = new Map();

/**
 * 「该账号上次**成功出题**的时刻」，按 `leoAccountId` 索引（模块级，跨任务共享）。
 *
 * 用途：出题接口的冷却是账号级的（实测 ≈61.6s，见 config.js）。
 * 记住这个时刻后，下一轮可以直接等到「上次成功 + 冷却」再发车，
 * 既不用猜窗口大小、也不会每次都白撞一次 —— 这就是「最快」的实现方式。
 */
const lastMatchOkAt = new Map();

/**
 * 任务事件监听器：jobId → Set<fn>。
 * 用于 SSE（`/api/jobs/:id/stream`）向网页实时推日志。
 */
const listeners = new Map();

/**
 * 事件回放缓冲：jobId → 最近 N 条事件。
 *
 * ## 为什么必须有它（这是「实时日志不显示」的根因）
 *
 * `startJob()` 会**同步**跑完 `runLoop` 的第一段（async 函数调用后同步执行到
 * 第一个 await），也就是说「任务开始」「第 1/N 轮开始」「等待 Xs」这几条事件
 * 在 HTTP 响应**写出之前**就已经 publish 了。前端要等响应回来才能 `new
 * EventSource()` —— 于是这些事件全部打在空气里，用户看到一片空白。
 *
 * 有了缓冲，`subscribe()` 时先把历史事件补发一遍，前端就能看到完整开头。
 */
const eventBuffers = new Map();
const EVENT_BUFFER_MAX = 300;

function subscribe(jobId, fn, opts) {
  const id = Number(jobId);
  let set = listeners.get(id);
  if (!set) { set = new Set(); listeners.set(id, set); }
  set.add(fn);

  // 先补发历史（默认开），再进入实时推送 —— 顺序不能反，否则日志会错乱
  const replay = !opts || opts.replay !== false;
  if (replay) {
    const buf = eventBuffers.get(id);
    if (buf) {
      for (const ev of buf) {
        try { fn(ev); } catch (e) { /* 单个订阅者出错不影响其它人 */ }
      }
    }
  }

  return () => {
    const s = listeners.get(id);
    if (s) { s.delete(fn); if (s.size === 0) listeners.delete(id); }
  };
}

function publish(jobId, ev) {
  const id = Number(jobId);
  const withTime = ev.at == null ? Object.assign({ at: Date.now() }, ev) : ev;

  // 1) 入缓冲区（供后来者回放）
  let buf = eventBuffers.get(id);
  if (!buf) { buf = []; eventBuffers.set(id, buf); }
  buf.push(withTime);
  if (buf.length > EVENT_BUFFER_MAX) buf.splice(0, buf.length - EVENT_BUFFER_MAX);

  // 2) 推给当前订阅者
  const set = listeners.get(id);
  if (!set) return;
  for (const fn of set) {
    try { fn(withTime); } catch (e) { /* 单个订阅者出错不影响任务 */ }
  }
}

/** 取某任务的事件缓冲（供 SSE 连接时做快照用）。 */
function bufferedEvents(jobId) {
  return (eventBuffers.get(Number(jobId)) || []).slice();
}

/** 任务彻底结束后清掉缓冲区（避免长期运行后内存堆积）。 */
function clearBuffer(jobId) {
  eventBuffers.delete(Number(jobId));
}

/** 由入库的 leo 账号构造 cookie jar。 */
function jarOf(account) {
  const items = JSON.parse(account.cookies_json);
  return new leo.CookieJar(items);
}

/**
 * 启动一个刷局任务（异步执行，立即返回 jobId）。
 *
 * @param {object} o
 * @param {number} o.jobId
 * @param {number} o.rounds        总局数
 * @param {number} o.pointId       知识点 ID
 * @param {number} [o.costTimeMs]
 * @param {number} [o.gapMinMs]
 * @param {number} [o.gapMaxMs]
 * @param {number} [o.rateLimitBaseMs]
 * @param {number} [o.rateLimitMaxWait]
 * @param {string} [o.note]
 * @returns {{ok:boolean, message?:string}}
 */
function startJob(o) {
  const job = db.getJob(o.jobId);
  if (!job) return { ok: false, message: '任务不存在' };
  if (running.has(job.id)) return { ok: false, message: '该任务已在运行' };

  // 允许并行：默认**不限制**（cap <= 0 即不限）。
  // 每个任务内部仍然串行（一轮一轮来），只是**任务之间**可以同时跑。
  // 想收紧就设 PK_MAX_CONCURRENT=<正整数>。
  const cap = Number(config.maxConcurrentJobs) || MAX_CONCURRENT;
  if (cap > 0 && running.size >= cap) {
    return { ok: false, message: `最多同时运行 ${cap} 个任务，请先停掉一些（可在高级参数里调）` };
  }

  const account = db.getLeoAccount(job.leo_account_id);
  if (!account) return { ok: false, message: '小猿账号不存在（可能已被删除）' };

  const jar = jarOf(account);
  const cfg = JSON.parse(job.config_json);

  // 「立即结束」靠这个 controller：既中断在途 HTTP，也中断等待中的 sleep
  const controller = new AbortController();
  // 出题冷却**按账号**共享：把「该账号上次成功出题的时刻」放进一个按
  // leoAccountId 索引的**模块级**表，这样换任务/换知识点也能接着贴窗口下沿，
  // 而不是每个新任务都从零重新白撞一次。
  const ctx = {
    stopped: false,
    jar: jar,
    config: cfg,
    controller: controller,
    signal: controller.signal,
    get lastMatchOkAt() { return lastMatchOkAt.get(job.leo_account_id) || 0; },
    set lastMatchOkAt(v) { lastMatchOkAt.set(job.leo_account_id, v); },
  };
  running.set(job.id, ctx);
  db.setJobStatus(job.id, 'running', { startedAt: Date.now() });
  publish(job.id, { type: 'status', message: '任务开始', at: Date.now() });

  // 后台跑（不 await，让 HTTP 请求立刻返回）
  runLoop(job, cfg, ctx).catch((e) => {
    // 被手动结束 → stopped（不是失败），别让用户看到一条吓人的 failed
    const aborted = e && e.aborted === true;
    db.setJobStatus(job.id, aborted ? 'stopped' : 'failed', {
      finishedAt: Date.now(),
      error: aborted ? null : e.message,
    });
    publish(job.id, {
      type: 'status',
      message: aborted ? '任务已立即结束' : ('任务异常：' + e.message),
      finished: true,
      at: Date.now(),
    });
  }).finally(() => {
    running.delete(job.id);
  });

  return { ok: true };
}

/**
 * 停止任务。
 *
 * `immediate=true`（默认）→ **立即结束**：中断在途 HTTP + 中断等待中的 sleep，
 * 不用等当前轮次跑完（否则最长要等 20s 的轮间隔）。
 * `immediate=false` → 老行为：等本轮结束再退。
 */
function stopJob(jobId, immediate) {
  const id = Number(jobId);
  const quick = immediate !== false;      // 默认立即
  const ctx = running.get(id);

  if (!ctx) {
    const job = db.getJob(id);
    if (job && (job.status === 'queued' || job.status === 'running')) {
      db.setJobStatus(id, 'stopped', { finishedAt: Date.now() });
      return { ok: true, message: '任务未在运行，已标记为停止' };
    }
    return { ok: false, message: '任务未在运行' };
  }

  ctx.stopped = true;
  if (quick && ctx.controller) {
    publish(id, { type: 'status', message: '收到「立即结束」，正在中断…', at: Date.now() });
    ctx.controller.abort();               // 掐断在途请求与 sleep
  } else {
    publish(id, { type: 'status', message: '收到停止请求，将在本轮结束后退出', at: Date.now() });
  }
  return { ok: true, immediate: quick };
}

/** 主循环：一轮一轮跑，每轮落库并广播。 */
async function runLoop(job, cfg, ctx) {  const jobId = job.id;
  let done = job.rounds_done || 0;
  let failed = job.rounds_failed || 0;

  // 子账号：本服务**无法切换**（服务端切号接口 417，且改 cookie 无效）。
  // 所以这里不把它当致命错误 —— 只如实告警，并报出「实际生效身份」，
  // 然后照常用该身份刷局（身份由服务端会话决定，往往本来就是想要的那个）。
  if (job.sub_user_id != null) {
    publish(jobId, { type: 'status', message: `请求使用子账号 ${job.sub_user_id}，正在确认…`, at: Date.now() });
    const r = await leoAccounts.switchTo(job.leo_account_id, Number(job.sub_user_id));
    if (r.ok) {
      publish(jobId, { type: 'status', message: r.message, at: Date.now() });
    } else {
      publish(jobId, { type: 'warn', message: '⚠️ ' + r.message, at: Date.now() });
      publish(jobId, { type: 'status', message: '继续使用当前生效身份刷局', at: Date.now() });
    }
  }

  // 开工前报一次「实际生效身份」——这是唯一可信的口径（服务端回包为准）
  {
    const who = await leoAccounts.currentIdentity(ctx.jar);
    publish(jobId, {
      type: 'status',
      message: '实际生效身份：' + (who == null ? '未知（登录态可能已失效）' : who),
      at: Date.now(),
    });
  }

  for (let i = done + 1; i <= job.rounds_total; i++) {
    if (ctx.stopped) {
      db.setJobStatus(jobId, 'stopped', { finishedAt: Date.now(), roundsDone: done, roundsFailed: failed });
      publish(jobId, { type: 'status', message: `已停止（完成 ${done}/${job.rounds_total}）`, at: Date.now() });
      return;
    }

    publish(jobId, { type: 'round', round: i, message: `第 ${i}/${job.rounds_total} 轮开始`, at: Date.now() });

    let res;
    try {
      res = await engine.runOneRound(ctx.jar, cfg, (ev) => {
        publish(jobId, Object.assign({ round: i, at: Date.now() }, ev));
      }, ctx);
    } catch (e) {
      // 被手动「立即结束」→ 直接收尾，标 stopped，不当失败
      if (e && e.aborted === true) {
        db.setJobStatus(jobId, 'stopped', { finishedAt: Date.now(), roundsDone: done, roundsFailed: failed });
        publish(jobId, { type: 'status', message: `已立即结束（完成 ${done}/${job.rounds_total}）`, finished: true, at: Date.now() });
        return;
      }
      res = { ok: false, httpCode: null, message: '异常：' + e.message, detail: '' };
    }

    if (res.ok) done++; else failed++;
    db.addJobRound(jobId, i, res.ok, res.httpCode, res.message, res.detail);
    db.setJobStatus(jobId, 'running', { roundsDone: done, roundsFailed: failed });
    publish(jobId, {
      type: res.ok ? 'ok' : 'fail',
      round: i,
      message: `第 ${i} 轮${res.ok ? '成功' : '失败'}：${res.message}`,
      httpCode: res.httpCode,
      detail: res.detail,
      at: Date.now(),
    });

    // 连续失败太多就停（避免把频控喂爆）
    if (failed >= 8 && done === 0) {
      db.setJobStatus(jobId, 'failed', {
        finishedAt: Date.now(), roundsDone: done, roundsFailed: failed,
        error: '连续失败过多（可能是频控或登录态失效）',
      });
      publish(jobId, { type: 'status', message: '连续失败过多，已中止', at: Date.now() });
      return;
    }
  }

  db.setJobStatus(jobId, 'done', { finishedAt: Date.now(), roundsDone: done, roundsFailed: failed });
  publish(jobId, {
    type: 'status',
    message: `任务完成：成功 ${done} / 失败 ${failed}`,
    at: Date.now(),
  });
}

/* ======================== 刷练习任务（2026-10-01 新增） ========================
 *
 * ## 为什么练习也要走这套调度
 *
 * 以前 `/api/exercise/run` 是**裸的 async IIFE**：不登记 running、不落库、
 * 不占并行名额。于是：
 *   · 「任务」页永远看不到刷练习；
 *   · 切到别的 tab（SSE 断开）再回来，日志空白，看起来「没在跑 / 被中断」；
 *   · 没法停止。
 *
 * 现在它和刷局任务**同源**：db 里一条 jobs 记录 + job_rounds 逐轮明细，
 * 共用同一套 `publish` / `subscribe` / `stopJob` / SSE。
 */

/**
 * 启动一个刷练习任务（异步执行，立即返回）。
 *
 * @param {object} o
 * @param {number} o.jobId  已入库的任务 id（config_json 里含 kind:'exercise'）
 * @returns {{ok:boolean, message?:string}}
 */
function startExerciseJob(o) {
  const job = db.getJob(o.jobId);
  if (!job) return { ok: false, message: '任务不存在' };
  if (running.has(job.id)) return { ok: false, message: '该任务已在运行' };

  const cap = Number(config.maxConcurrentJobs) || MAX_CONCURRENT;
  if (cap > 0 && running.size >= cap) {
    return { ok: false, message: `最多同时运行 ${cap} 个任务，请先停掉一些（可在高级参数里调）` };
  }

  const account = db.getLeoAccount(job.leo_account_id);
  if (!account) return { ok: false, message: '小猿账号不存在（可能已被删除）' };

  const cfg = JSON.parse(job.config_json);
  const controller = new AbortController();
  const ctx = {
    stopped: false,
    jar: jarOf(account),
    config: cfg,
    controller: controller,
    signal: controller.signal,
  };
  running.set(job.id, ctx);
  db.setJobStatus(job.id, 'running', { startedAt: Date.now() });
  publish(job.id, {
    type: 'status', exercise: true, jobId: job.id,
    message: `练习任务开始：${job.rounds_total} 轮 × ${cfg.limit} 题（知识点 ${cfg.keypointId}）`,
    at: Date.now(),
  });

  runExerciseLoop(job, cfg, ctx).catch((e) => {
    // startExerciseJob 里 runExerciseLoop 已自行 try/catch，这里是最后兜底
    const aborted = e && e.aborted === true;
    db.setJobStatus(job.id, aborted ? 'stopped' : 'failed', {
      finishedAt: Date.now(), error: aborted ? null : e.message,
    });
    publish(job.id, {
      type: 'status', exercise: true, jobId: job.id, finished: true,
      message: aborted ? '练习已停止' : ('练习任务异常：' + e.message),
      at: Date.now(),
    });
  }).finally(() => { running.delete(job.id); });

  return { ok: true };
}

/** 练习主循环：把 practiceLoop 的每一轮事件落库 + 广播。 */
async function runExerciseLoop(job, cfg, ctx) {
  const jobId = job.id;
  let done = job.rounds_done || 0;
  let failed = job.rounds_failed || 0;

  const emit = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    const e = Object.assign({}, ev, { exercise: true, jobId: jobId });
    publish(jobId, e);
    // 同时镜像到「练习通道 0」：前端订阅 /api/exercise/stream 时能一次性看到
    // 所有练习任务的日志（按 jobId 过滤）。带上 userId 避免多用户串台。
    publish(0, Object.assign({}, e, { userId: job.user_id }));
    // 每轮结束 → 落库（与刷局同一张 job_rounds 表，「任务」页的「明细」直接可用）
    if (ev.round != null && (ev.type === 'ex-round-ok' || ev.type === 'ex-round-fail')) {
      const ok = ev.type === 'ex-round-ok';
      if (ok) done++; else failed++;
      db.addJobRound(jobId, ev.round, ok, ok ? 200 : (ev.status || null), ev.message, ev.detail);
      db.setJobStatus(jobId, 'running', { roundsDone: done, roundsFailed: failed });
    }
  };

  try {
    const r = await exercise.practiceLoop(ctx.jar, {
      rounds: cfg.rounds, limit: cfg.limit, keypointId: cfg.keypointId,
      gapMinMs: cfg.gapMinMs, gapMaxMs: cfg.gapMaxMs,
      costTimePerQuestionMs: cfg.costTimePerQuestionMs,
      signal: ctx.signal,
      onEvent: emit,
    });
    done = r.done; failed = r.failed;
    db.setJobStatus(jobId, 'done', { finishedAt: Date.now(), roundsDone: done, roundsFailed: failed });
    // 收尾核对一次周分数（只读接口，不计入任何频控）——「经验到底到账没」的唯一可信口径
    let scoreMsg = '';
    try {
      const score = await exercise.readScore(ctx.jar);
      if (score != null) scoreMsg = `，当前 curWeekScore=${score}`;
    } catch (e) { /* 核对失败不影响任务结论 */ }
    publish(jobId, {
      type: 'status', exercise: true, jobId: jobId, finished: true,
      message: `练习任务完成：成功 ${done} / ${r.rounds}，失败 ${failed}，累计经验 +${r.totalExp}${scoreMsg}`,
      at: Date.now(),
    });
  } catch (e) {
    const aborted = e && e.aborted === true;
    db.setJobStatus(jobId, aborted ? 'stopped' : 'failed', {
      finishedAt: Date.now(), roundsDone: done, roundsFailed: failed,
      error: aborted ? null : e.message,
    });
    publish(jobId, {
      type: 'status', exercise: true, jobId: jobId, finished: true,
      message: aborted ? `练习已停止（完成 ${done}）` : ('练习任务异常：' + e.message),
      at: Date.now(),
    });
  }
}

/** 是否有任务在跑（UI 用来提示）。 */
function isBusy() {
  return running.size > 0;
}

/** 正在运行的任务数 / 上限（cap=0 表示不限制，UI 显示「2 个在跑」）。 */
function runningCount() {
  const cap = Number(config.maxConcurrentJobs) || MAX_CONCURRENT;
  return { running: running.size, cap: cap > 0 ? cap : null };
}

/** 运行中的任务 id 列表。 */
function runningIds() {
  return Array.from(running.keys());
}

module.exports = {
  MAX_CONCURRENT,
  startJob,
  startExerciseJob,
  stopJob,
  subscribe,
  publish,
  bufferedEvents,
  clearBuffer,
  isBusy,
  runningCount,
  runningIds,
  jarOf,
};