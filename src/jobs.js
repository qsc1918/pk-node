'use strict';
// 任务调度器：串行跑刷局任务，支持停止；每轮结果落库 + 内存事件流。
//
// 为什么串行：提交接口有独立频控（403，窗口约十分钟级），并发只会把请求一起打进频控窗口，
// 反而更慢且更易被风控标记；同一时刻最多一个任务在跑，任务内部一轮一轮来。
// 停止语义：置内存标志 + 落库状态，正在 await 的轮次结束后下一轮开始前检查并退出，不强行中断在途 HTTP。

const db = require('./db');
const leo = require('./leo');
const leoAccounts = require('./services/leo-accounts');
const engine = require('./pk-engine');
const exercise = require('./exercise');
const schoolSeason = require('./school-season');
const { config } = require('./config');

/** 默认最大并行任务数：0 = 不限制（可用 `PK_MAX_CONCURRENT=<正整数>` 设上限）。 */
const MAX_CONCURRENT = 0;

/** 运行中的任务表：jobId → { stopped:boolean, jar, config } */
const running = new Map();

/**
 * 「该账号上次成功出题的时刻」，按 leoAccountId 索引（模块级，跨任务共享）。
 * 出题冷却是账号级的；记住这个时刻后下一轮直接等到「上次成功 + 冷却」再发车。
 */
const lastMatchOkAt = new Map();

/**
 * 任务事件监听器：jobId → Set<fn>。
 * 用于 SSE（`/api/jobs/:id/stream`）向网页实时推日志。
 */
const listeners = new Map();

/**
 * 事件回放缓冲：jobId → 最近 N 条事件。
 * 根因：startJob() 同步跑完 runLoop 第一段（到第一个 await），「任务开始」等事件在 HTTP 响应写出前就 publish 了，
 * 前端要等响应回来才能 new EventSource()，事件全打在空气里；缓冲让 subscribe() 先补发历史。
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

/**
 * 由入库的 leo 账号构造 cookie jar。
 *
 * 账号若「指定了使用哪份设备链」（device_chain_id），这里把那份 ks_* 覆盖到 jar 上 ——
 * 保证刷局/刷练习用的就是这个用户给他选的那条链；没指定才走池里轮换。
 */
function jarOf(account) {
  const items = JSON.parse(account.cookies_json);
  const jar = new leo.CookieJar(items);
  try {
    if (account && account.device_chain_id != null) {
      leoAccounts.applyDeviceChain(jar, { boundChainId: account.device_chain_id });
    }
  } catch (e) {
    // 绑定链取不出来不该让整个任务起不来：原 cookie 里可能已经自带 ks_*
    console.warn('[jobs] 应用账号设备链失败（改用 cookie 自带）：' + e.message);
  }
  return jar;
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
    // 'stop' = 彻底结束；'pause' = 暂停（保留进度，可「继续」从下一轮接着跑）
    paused: false,
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
    // 被手动结束 → stopped / paused（不是失败）。
    // ⚠️ 优先级：用户显式「暂停」优先于任何异常 —— 暂停时中断在途请求抛出的网络错误不应判成 failed。
    const aborted = e && e.aborted === true;
    const paused = ctx.paused;
    db.setJobStatus(job.id, paused ? 'paused' : (aborted ? 'stopped' : 'failed'), {
      finishedAt: Date.now(),
      error: (paused || aborted) ? null : e.message,
    });
    publish(job.id, {
      type: 'status',
      message: paused ? '任务已暂停' : (aborted ? '任务已立即结束' : ('任务异常：' + e.message)),
      finished: !paused,
      at: Date.now(),
    });
  }).finally(() => {
    running.delete(job.id);
  });

  return { ok: true };
}

/**
 * 停止 / 暂停任务。
 * `immediate=true`（默认）→ 立即结束：中断在途 HTTP + 等待中的 sleep，不用等当前轮次跑完。
 * `immediate=false` → 等本轮结束再退。
 * `mode='pause'`：立即中断但状态记 paused（保留已跑轮数），「继续」时从 rounds_done+1 接着跑。
 * @param {number} jobId
 * @param {boolean} [immediate] 默认 true
 * @param {{mode?:'stop'|'pause'}} [opts]
 */
function stopJob(jobId, immediate, opts) {
  const id = Number(jobId);
  const quick = immediate !== false;      // 默认立即
  const mode = (opts && opts.mode) || 'stop';
  const pause = mode === 'pause';
  const ctx = running.get(id);

  if (!ctx) {
    const job = db.getJob(id);
    if (job && (job.status === 'queued' || job.status === 'running' || job.status === 'paused')) {
      db.setJobStatus(id, pause ? 'paused' : 'stopped', { finishedAt: Date.now() });
      return { ok: true, message: '任务未在运行，已标记为' + (pause ? '暂停' : '停止') };
    }
    return { ok: false, message: '任务未在运行' };
  }

  ctx.stopped = true;
  if (pause) ctx.paused = true;
  if (quick && ctx.controller) {
    publish(id, {
      type: 'status',
      message: pause ? '收到「暂停」，正在中断…' : '收到「立即结束」，正在中断…',
      at: Date.now(),
    });
    ctx.controller.abort();               // 掐断在途请求与 sleep
  } else {
    publish(id, {
      type: 'status',
      message: pause ? '收到暂停请求，将在本轮结束后挂起' : '收到停止请求，将在本轮结束后退出',
      at: Date.now(),
    });
  }
  return { ok: true, immediate: quick, mode: mode };
}

/**
 * 继续一个「已暂停 / 已停止」的任务（从下一轮接着跑，已刷的局不丢）。
 * 暂停时 rounds_done 已落库，主循环从 rounds_done+1 开始，沿用同一 jobId 重跑即天然断点续跑。
 * @param {number} jobId
 * @returns {{ok:boolean, message?:string, jobId?:number, resumedFrom?:number}}
 */
function resumeJob(jobId) {
  const id = Number(jobId);
  const job = db.getJob(id);
  if (!job) return { ok: false, message: '任务不存在' };
  if (running.has(id)) return { ok: false, message: '该任务正在运行中' };
  if (job.status !== 'paused' && job.status !== 'stopped' && job.status !== 'queued') {
    return { ok: false, message: '只有「已暂停 / 已停止」的任务可以继续' };
  }
  if ((job.rounds_done || 0) >= job.rounds_total) {
    return { ok: false, message: '任务已跑完全部轮次，没有可继续的' };
  }

  let kind = 'pk';
  try { kind = (JSON.parse(job.config_json) || {}).kind || 'pk'; } catch (e) { /* 保持 pk */ }

  // 清掉上次结束的痕迹，回到「排队中」再由 start*Job 置为 running
  db.setJobStatus(id, 'queued', { finishedAt: null, error: null });
  const start = kind === 'exercise' ? startExerciseJob({ jobId: id })
    : kind === 'race' ? startRaceJob({ jobId: id })
    : startJob({ jobId: id });
  if (!start.ok) return start;
  return {
    ok: true,
    jobId: id,
    resumedFrom: (job.rounds_done || 0) + 1,
    roundsTotal: job.rounds_total,
    message: `已继续：从第 ${(job.rounds_done || 0) + 1}/${job.rounds_total} 轮接着跑`,
  };
}

/**
 * ★ 2026-10-05：**叠加轮数**（用户要求「开始后可以继续点击开始，继续的点击视为叠加轮数」）。
 *
 * 把 `jobs.rounds_total` 加上 [extra]。主循环每轮边界会重读该值，所以**立即生效**：
 * 已经跑完的局不丢，任务会继续跑到新的总轮数。
 *
 * 与 [resumeJob] 的分工：
 *  - 任务**已结束**（done/stopped/failed）→ 用 `resumeJob` 从断点续跑；
 *  - 任务**还在跑** → 用本函数叠加轮数（不重启任务，不打断当前局）。
 *
 * @param {number} jobId
 * @param {number} extra 要追加的轮数（>=1）
 * @returns {{ok:boolean, message:string, roundsTotal?:number}}
 */
function extendJobRounds(jobId, extra) {
  const id = Number(jobId);
  const add = Math.floor(Number(extra));
  if (!Number.isFinite(add) || add < 1) return { ok: false, message: '追加轮数必须是正整数' };
  const job = db.getJob(id);
  if (!job) return { ok: false, message: '任务不存在' };

  const before = Number(job.rounds_total) || 0;
  const after = before + add;
  // 上限保护：与 makeRaceConfig 的 clampRounds 一致，防误点成天文数字
  if (after > 100000) return { ok: false, message: `总轮数不能超过 100000（当前 ${before}）` };

  db.setJobRoundsTotal(id, after);
  const isRace = (() => {
    try { return (JSON.parse(job.config_json) || {}).kind === 'race'; } catch (e) { return false; }
  })();
  if (isRace) {
    publishRaceStatus(job, {
      type: 'status', jobId: id, roundsTotal: after,
      message: `轮数叠加：${before} → ${after}（+${add}）`,
      at: Date.now(),
    });
  } else {
    publish(id, { type: 'status', message: `轮数叠加：${before} → ${after}（+${add}）`, at: Date.now() });
  }
  return {
    ok: true,
    roundsTotal: after,
    message: running.has(id)
      ? `已叠加到 ${after} 局，任务继续跑`
      : `已叠加到 ${after} 局（任务当前不在运行，「继续」后按新轮数跑）`,
  };
}

/**
 * 把某用户所有还没跑完的任务停掉 / 暂停。
 * 用途：管理员禁用/删除用户时，必须连带停掉他正在跑的任务，否则界面禁用、后台还在刷局。
 * @param {number} userId
 * @param {{mode?:'stop'|'pause'}} [opts]
 * @returns {number} 受影响的任务数
 */
function stopJobsByUser(userId, opts) {
  const mode = (opts && opts.mode) || 'pause';
  const uid = Number(userId);
  let n = 0;
  // 1) 真正在跑的：走正规停止流程（会中断在途请求）
  for (const id of Array.from(running.keys())) {
    const job = db.getJob(id);
    if (job && Number(job.user_id) === uid) {
      stopJob(id, true, { mode: mode });
      n++;
    }
  }
  // 2) 库里残留的 queued / paused（进程重启过、或压根没起来）：直接落状态
  for (const job of db.listActiveJobsByUser(uid)) {
    if (running.has(job.id)) continue;
    db.setJobStatus(job.id, mode === 'pause' ? 'paused' : 'stopped', { finishedAt: Date.now() });
    n++;
  }
  return n;
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
      // 暂停（paused）与停止（stopped）都在这里收尾，区别只在落库状态：
      // paused 保留已跑轮数，之后可以「继续」；stopped 视为彻底结束。
      db.setJobStatus(jobId, ctx.paused ? 'paused' : 'stopped', {
        finishedAt: Date.now(), roundsDone: done, roundsFailed: failed,
      });
      publish(jobId, {
        type: 'status',
        message: ctx.paused
          ? `已暂停（完成 ${done}/${job.rounds_total}，可点「继续」接着跑）`
          : `已停止（完成 ${done}/${job.rounds_total}）`,
        finished: !ctx.paused,
        at: Date.now(),
      });
      return;
    }

    publish(jobId, { type: 'round', round: i, message: `第 ${i}/${job.rounds_total} 轮开始`, at: Date.now() });

    let res;
    try {
      res = await engine.runOneRound(ctx.jar, cfg, (ev) => {
        publish(jobId, Object.assign({ round: i, at: Date.now() }, ev));
      }, ctx);
    } catch (e) {
      // 被手动「立即结束 / 暂停」→ 直接收尾，不当失败
      if (e && e.aborted === true) {
        db.setJobStatus(jobId, ctx.paused ? 'paused' : 'stopped', {
          finishedAt: Date.now(), roundsDone: done, roundsFailed: failed,
        });
        publish(jobId, {
          type: 'status',
          message: ctx.paused
            ? `已暂停（完成 ${done}/${job.rounds_total}，可点「继续」接着跑）`
            : `已立即结束（完成 ${done}/${job.rounds_total}）`,
          finished: !ctx.paused,
          at: Date.now(),
        });
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

/* ======================== 刷练习任务（与刷局任务同源调度） ========================
 * 练习任务也登记 running、落库、占并行名额，共用 publish/subscribe/stopJob/SSE，
 * 这样「任务」页可见、切 tab 不丢日志、可停止。
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
    paused: false,
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
    // startExerciseJob 里 runExerciseLoop 已自行 try/catch，这里是最后兜底。
    // 同刷局：**用户显式暂停优先于任何异常**（中断在途请求带来的网络错误不算失败）。
    const aborted = e && e.aborted === true;
    const paused = ctx.paused;
    db.setJobStatus(job.id, paused ? 'paused' : (aborted ? 'stopped' : 'failed'), {
      finishedAt: Date.now(), error: (paused || aborted) ? null : e.message,
    });
    publish(job.id, {
      type: 'status', exercise: true, jobId: job.id, finished: !paused,
      message: paused ? '练习已暂停' : (aborted ? '练习已停止' : ('练习任务异常：' + e.message)),
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
    // 期间被暂停 → 落 paused（保留进度），别标成「已完成」
    if (ctx.stopped) {
      db.setJobStatus(jobId, ctx.paused ? 'paused' : 'stopped', {
        finishedAt: Date.now(), roundsDone: done, roundsFailed: failed,
      });
      publish(jobId, {
        type: 'status', exercise: true, jobId: jobId, finished: !ctx.paused,
        message: ctx.paused ? `练习已暂停（完成 ${done}，可点「继续」接着跑）` : `练习已停止（完成 ${done}）`,
        at: Date.now(),
      });
      return;
    }
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
    const paused = ctx.paused;
    db.setJobStatus(jobId, paused ? 'paused' : (aborted ? 'stopped' : 'failed'), {
      finishedAt: Date.now(), roundsDone: done, roundsFailed: failed,
      error: (paused || aborted) ? null : e.message,
    });
    publish(jobId, {
      type: 'status', exercise: true, jobId: jobId, finished: !paused,
      message: paused
        ? `练习已暂停（完成 ${done}，可点「继续」接着跑）`
        : (aborted ? `练习已停止（完成 ${done}）` : ('练习任务异常：' + e.message)),
      at: Date.now(),
    });
  }
}

/** 是否有任务在跑（UI 用来提示）。 */
function isBusy() {
  return running.size > 0;
}

/* ======================== 开学季竞速任务（kind='race'） ========================
 * 与刷局/刷练习同源调度：登记 running、落库、占并行名额，共用 publish/subscribe/stopJob/SSE。
 * 单轮 = 一局 8 人竞速（匹配 → 对战 → 逐题作答 → 结算）。
 */

/**
 * 发一条**竞速状态**事件：同时进「任务通道」与「竞速镜像通道 0」。
 *
 * ★ 2026-10-05：这两个通道缺一不可。
 *  - 任务通道（`publish(job.id, …)`）：pk-node 网页「任务」页、任务详情用；
 *  - 镜像通道 0（`raceMirror: true`）：**App 的 `/api/race/stream` 只订阅这个**
 *    （见 server.js 的 `jobs.subscribe(0, …)`）。此前状态事件只发了前者，
 *    导致 App 收不到「已完成 / 已停止」→ 开始按钮永久禁用、停止无回执。
 *
 * @param {object} job 任务行（要 job.id / job.user_id）
 * @param {object} ev  事件体（`type`/`message`/`finished` 等）
 */
function publishRaceStatus(job, ev) {
  const base = Object.assign({ race: true, jobId: job.id }, ev);
  publish(job.id, base);
  publish(0, Object.assign({}, base, { raceMirror: true, userId: job.user_id }));
}

/**
 * 启动一个开学季竞速任务（异步执行，立即返回）。
 *
 * @param {object} o
 * @param {number} o.jobId  已入库的任务 id（config_json 里含 kind:'race'）
 * @returns {{ok:boolean, message?:string}}
 */
function startRaceJob(o) {
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
    paused: false,
    jar: jarOf(account),
    config: cfg,
    controller: controller,
    signal: controller.signal,
  };
  running.set(job.id, ctx);
  db.setJobStatus(job.id, 'running', { startedAt: Date.now() });
  // ★ 2026-10-05：状态事件**必须同时镜像到通道 0**。
  //   原因：App（`RaceViewModel`）订阅的是 `/api/race/stream` → 服务端
  //   `jobs.subscribe(0, …)` 只认 `raceMirror: true` 的事件。局内的细粒度日志
  //   走 `emit()`（本来就镜像），而「任务开始 / 已停止 / 已完成」这类**状态**
  //   此前只 publish 到 jobId 通道 → App 收不到「完成」→ `running` 永远为 true
  //   → 开始按钮永久禁用（用户报「一局后无法继续」），停止后也没有回执
  //   （用户报「停止无效」）。
  publishRaceStatus(job, {
    type: 'status', jobId: job.id,
    message: `竞速任务开始：${job.rounds_total} 局（知识点 ${cfg.pointId || '自动'}，` +
      (cfg.aimCostMode
        ? (cfg.aimPerfectMode ? '完美贴限，' : '贴限模式，') +
          `安全边距 ${Number(cfg.aimSafetyMs) >= 0 ? Number(cfg.aimSafetyMs) : 40}ms）`
        : `提交延迟 ${cfg.answerDelayMinMs || 0}~${cfg.answerDelayMaxMs || 0}ms）`),
    at: Date.now(),
  });

  runRaceLoop(job, cfg, ctx).catch((e) => {
    const aborted = e && e.aborted === true;
    const paused = ctx.paused;
    db.setJobStatus(job.id, paused ? 'paused' : (aborted ? 'stopped' : 'failed'), {
      finishedAt: Date.now(), error: (paused || aborted) ? null : e.message,
    });
    publishRaceStatus(job, {
      type: 'status', jobId: job.id, finished: true,
      message: paused ? '竞速已暂停' : (aborted ? '竞速已停止' : ('竞速任务异常：' + e.message)),
      at: Date.now(),
    });
  }).finally(() => { running.delete(job.id); });

  return { ok: true };
}

/** 竞速主循环：一局一局跑，每局落库 + 广播。 */
async function runRaceLoop(job, cfg, ctx) {
  const jobId = job.id;
  let done = job.rounds_done || 0;
  let failed = job.rounds_failed || 0;

  const emit = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    const e = Object.assign({}, ev, { race: true, jobId: jobId });
    publish(jobId, e);
    // 镜像到「竞速通道 0」：前端订阅 /api/race/stream 时能看到日志（按 jobId 过滤）
    publish(0, Object.assign({}, e, { raceMirror: true, userId: job.user_id }));
  };

  // 年级解析：配置 0 = 用账号年级（grade 传 0 会让服务端返回空知识点列表，必须回落到有效值）
  const leoAcc = db.getLeoAccount(job.leo_account_id);
  const grade = Number(cfg.grade) > 0 ? Number(cfg.grade) : (Number(leoAcc && leoAcc.grade) || 2);
  if (Number(cfg.grade) !== grade) {
    emit({ type: 'ss-status', message: `年级未指定 → 用账号年级 ${grade}`, at: Date.now() });
  }

  // ★ 贴限模式（aimCostMode）：安全边距跨局自调。
  // 默认 0（= 精确瞄准榜一）；未达标时按差值自适应加大，刷新最佳后收紧。
  let aimSafety = Number(cfg.aimSafetyMs) >= 0 ? Number(cfg.aimSafetyMs) : 0;
  // ★ 2026-10-05 闭环修正量（**每题延迟**的偏移，不进 target）——
  //   见下方「贴限闭环」段：用上一局实测偏差折成每题毫秒，修正下一局。
  let delayAdjMs = 0;

  // ★★ 2026-10-05：主循环的**每轮边界重读 rounds_total**，而不是用启动时的快照。
  //
  // 这是「叠加轮数」的落地点：用户在 App / 网页上再点一次「开始」时，
  // 服务端走 `/api/jobs/:id/extend` 把 `jobs.rounds_total` 加上去；主循环
  // 若还拿着旧快照（`job.rounds_total`），就永远跑不到新轮次。
  //
  // ⚠️ 每轮多一次 `db.getJob` 的代价可忽略（一轮 = 一整局竞速，几十秒）。
  const readTotal = () => {
    const fresh = db.getJob(jobId);
    return (fresh && Number(fresh.rounds_total)) || job.rounds_total;
  };
  let total = readTotal();

  for (let i = done + 1; i <= total; i++) {
    // 每轮开头刷新一次总轮数（叠加轮数后立刻生效）
    const t = readTotal();
    if (t !== total) {
      emit({ type: 'ss-total', message: `总轮数更新：${total} → ${t}（叠加生效）`, at: Date.now() });
      total = t;
      publishRaceStatus(job, {
        type: 'status', jobId: jobId, roundsTotal: total,
        message: `轮数已叠加到 ${total} 局`, at: Date.now(),
      });
    }
    if (ctx.stopped) {
      db.setJobStatus(jobId, ctx.paused ? 'paused' : 'stopped', {
        finishedAt: Date.now(), roundsDone: done, roundsFailed: failed,
      });
      publishRaceStatus(job, {
        type: 'status', jobId: jobId, finished: true,
        message: ctx.paused
          ? `已暂停（完成 ${done}/${total} 局，可点「继续」接着跑）`
          : `已停止（完成 ${done}/${total} 局）`,
        at: Date.now(),
      });
      return;
    }

    emit({ type: 'ss-round', round: i, message: `第 ${i}/${total} 局开始`, at: Date.now() });

    let res;
    try {
      res = await schoolSeason.runOneRace(ctx.jar, {
        pointId: cfg.pointId, questionCount: cfg.questionCount, grade: grade,
        answerDelayMinMs: cfg.answerDelayMinMs, answerDelayMaxMs: cfg.answerDelayMaxMs,
        aimCostMode: cfg.aimCostMode === true, aimSafetyMs: aimSafety,
        aimDelayAdjMs: delayAdjMs,
        aimPerfectMode: cfg.aimPerfectMode === true,
        useSample: cfg.useSample !== false,
        battleMaxMs: cfg.battleMaxMs,
      }, (ev) => emit(Object.assign({ round: i, at: Date.now() }, ev)), ctx.signal);
    } catch (e) {
      if (e && e.aborted === true) {
        db.setJobStatus(jobId, ctx.paused ? 'paused' : 'stopped', {
          finishedAt: Date.now(), roundsDone: done, roundsFailed: failed,
        });
        publishRaceStatus(job, {
          type: 'status', jobId: jobId, finished: true,
          message: ctx.paused
            ? `已暂停（完成 ${done}/${total} 局，可点「继续」接着跑）`
            : `已立即结束（完成 ${done}/${total} 局）`,
          at: Date.now(),
        });
        return;
      }
      res = { ok: false, message: '异常：' + e.message, detail: '' };
    }

    if (res.ok) done++; else failed++;
    db.addJobRound(jobId, i, res.ok, res.ok ? 200 : null,
      res.message + (res.rank != null ? `（名次 ${res.rank}/8）` : ''),
      res.detail || '');
    db.setJobStatus(jobId, 'running', { roundsDone: done, roundsFailed: failed });
    publish(jobId, {
      type: res.ok ? 'ok' : 'fail', race: true, jobId: jobId, round: i,
      message: `第 ${i} 局${res.ok ? '成功' : '失败'}：${res.message}`,
      detail: res.detail, at: Date.now(),
    });

    // ★★ 贴限反馈自调 + 完美贴限重试（2026-10-05 三次修正后定稿）。
    //
    // ## 判据
    //
    // `self` 是「**我的历史最佳**」，不是「本局结果」：一旦我在该榜有过成绩，
    // `self.rank` 永远不是 999，**无论本局是否达标**。所以「已上榜」不能拿来判本局
    // —— 唯一可靠的是 `aimIsNewBest`（本局 costTime === self.costTime，即刷新了最佳）。
    //
    // ## 目标
    //
    // 客户口径：「其实你只需要看榜一排名就行了」—— 下限 = 榜一 costTime。
    // 所以目标是**让我的最佳贴到榜一**（等于榜一 = 并列第一）。
    //
    // ## 用闭环代替开环模型（关键）
    //
    // 开环模型 `delay = target/N - 184` 里的 184（每题固定开销）实测会漂
    //（实测 182.9 / 184 / 208.6 —— 随链路耗时波动 ±30ms），导致目标差几百毫秒。
    //
    // 改闭环：用**本局实测**修正**下一局的每题延迟**（delayAdjMs）：
    //
    //     errMs      = 本局 costTime - 本局目标 costTime
    //     delayAdjMs -= errMs / N × 0.6      ← 跑慢了(err>0) → **减少**每题延迟
    //
    // ⚠️ 两个反面教训（2026-10-05，都实测踩过）：
    //  ① 把 err 累加到 `aimSafety`（它会先加进 target、再被下一步的 err 重复计入）
    //     → **正反馈发散**（实测 4989→5080→5795→6209）。
    //     修正量必须放在**不进 target** 的独立变量里。
    //  ② **符号不能反**：`err>0` 表示「跑慢了」，要**减少**延迟（`-=`）。
    //     写成 `+=` 会越跑越慢（实测 5585→6048→6718→7540→8211）。
    if (cfg.aimCostMode) {
      const perfect = cfg.aimPerfectMode === true;
      const newBest = res.aimIsNewBest === true;          // 本局刷新了我的最佳
      const selfCost = res.aimSelfCost;
      const baseLimit = res.aim && res.aim.base;          // 该榜榜一（= 下限 = 目标）
      const targetCost = res.aim && res.aim.target;       // 本局的目标 costTime
      const nQ = Math.max(1, (res.aim && res.aim.questionCount) || 10);
      // 「已达完美」= 我的最佳已经贴到榜一
      const reachedPerfect = baseLimit != null && selfCost != null && selfCost <= baseLimit + 1;

      if (newBest) {
        emit({
          type: 'ss-aim-adjust',
          message: `贴限：本局刷新我的最佳 → ${selfCost}ms` +
            (baseLimit != null ? `（该榜榜一 ${baseLimit}ms，还差 ${selfCost - baseLimit}ms）` : ''),
          at: Date.now(),
        });
      }

      if (perfect && reachedPerfect) {
        publishRaceStatus(job, {
          type: 'status', jobId: jobId,
          message: `🎯 完美贴限达成：我的最佳 ${selfCost}ms 已贴到该榜榜一 ${baseLimit}ms，不再重试`,
          at: Date.now(),
        });
      } else if (targetCost != null && res.costTimeMs != null) {
        // ★ 闭环修正（阻尼 0.35，折成每题延迟；跑慢了要**减少**延迟）
        //
        // 阻尼 0.6 实测会过冲到下限之下（4868/4888 < 4900 → 被判异常），
        // 所以降到 0.35，并加「**不许低于目标**」的钳制：宁可略高也别被打回。
        const errMs = res.costTimeMs - targetCost;
        const delta = Math.round((errMs / nQ) * 0.35);
        const before = delayAdjMs;
        // 下限钳制：每题延迟最多只能降到「刚好命中目标」的那个值
        // （perQ = target/N - overhead + adj，令其为 0 → adj = overhead - target/N）
        const ovh = Number(res.aim && res.aim.overhead) || 184;
        const floorAdj = -Math.round(Math.max(0, (targetCost / nQ) - ovh));
        delayAdjMs = Math.max(floorAdj, Math.min(2000, delayAdjMs - delta));
        emit({
          type: 'ss-aim-adjust',
          message: `贴限闭环：本局实测 ${res.costTimeMs}ms vs 目标 ${targetCost}ms（${errMs > 0 ? '慢了' : '快了'} ` +
            `${Math.abs(errMs)}ms）→ 下局每题延迟修正 ${before} → ${delayAdjMs}ms`,
          at: Date.now(),
        });
      }

      // 完美贴限：未达成 → 追加轮次继续（受上限保护）
      if (perfect && !reachedPerfect) {
        const cap = Math.max(1, Number(cfg.aimPerfectMaxRounds) || 30);
        const attempts = i - (job.rounds_done || 0);
        if (attempts >= cap) {
          publishRaceStatus(job, {
            type: 'status', jobId: jobId,
            message: `完美贴限：已尝试 ${attempts} 局仍未贴到下限（我的最佳 ${selfCost == null ? '?' : selfCost}ms，` +
              `下限 ${baseLimit == null ? '?' : baseLimit}ms），停止重试（上限 ${cap} 局）`,
            at: Date.now(),
          });
        } else {
          const next = readTotal() + 1;
          db.setJobRoundsTotal(jobId, next);
          total = next;
          publishRaceStatus(job, {
            type: 'status', jobId: jobId, roundsTotal: total,
            message: `完美贴限未达成（我的最佳 ${selfCost == null ? '?' : selfCost}ms vs 下限 ` +
              `${baseLimit == null ? '?' : baseLimit}ms）→ 自动追加第 ${next} 局重试`,
            at: Date.now(),
          });
        }
      }
    }

    // 连续失败太多就停
    if (failed >= 5 && done === 0) {
      db.setJobStatus(jobId, 'failed', {
        finishedAt: Date.now(), roundsDone: done, roundsFailed: failed,
        error: '连续失败过多（可能是登录态失效或活动已结束）',
      });
      publishRaceStatus(job, { type: 'status', jobId: jobId, finished: true, message: '连续失败过多，已中止', at: Date.now() });
      return;
    }

    // 局间间隔（可配）
    if (i < total) {
      const gapMin = Math.max(0, Number(cfg.gapMinMs) || 0);
      const gapMax = Math.max(gapMin, Number(cfg.gapMaxMs) || 0);
      const gap = gapMax > gapMin ? gapMin + Math.floor(Math.random() * (gapMax - gapMin)) : gapMin;
      if (gap > 0) {
        emit({ type: 'ss-gap', message: `等待 ${(gap / 1000).toFixed(1)}s 后开下一局`, at: Date.now() });
        try { await require('./pk-engine').sleepAbortable(gap, ctx.signal); }
        catch (e) {
          if (e && e.aborted) {
            db.setJobStatus(jobId, ctx.paused ? 'paused' : 'stopped', {
              finishedAt: Date.now(), roundsDone: done, roundsFailed: failed,
            });
            return;
          }
        }
      }
    }
  }

  db.setJobStatus(jobId, 'done', { finishedAt: Date.now(), roundsDone: done, roundsFailed: failed });
  publishRaceStatus(job, {
    type: 'status', jobId: jobId, finished: true,
    message: `竞速任务完成：成功 ${done} / 失败 ${failed}`,
    at: Date.now(),
  });
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
  startRaceJob,
  stopJob,
  resumeJob,
  extendJobRounds,
  stopJobsByUser,
  subscribe,
  publish,
  bufferedEvents,
  clearBuffer,
  isBusy,
  runningCount,
  runningIds,
  jarOf,
};