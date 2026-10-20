'use strict';
// PK 刷局引擎：出题 → 组装提交 body → 加密提交 → 频控退避。
//
// ## 提交 body 结构（★ 2026-10-20 修正：这是「提交 400」的真因）
//
// 服务端在 2026-10 中旬改了口径：**必须**是「外层 + 嵌套 examVO 副本 + userInfos」，
// 缺任一项一律 `400 {"status":400,"message":"error"}`（且与 body 内容无关，
// 传空 body 也是同一个 400，所以从响应上完全看不出缺什么）。
//
// 权威来源：线上 H5 `result.html` 的 `Result-legacy.*.js` ——
//
// ```js
//   y = { ...examVO, questions, correctCnt, costTime, updatedTime: Date.now() }
//   A = { ...y, examVO: y, userInfos: opponents.map(o => o.userInfo) }
//   api.put('/leo-game-pk/{client}/math/pk/submit', dataEncrypt(A), { params })
// ```
//
// 实测矩阵（同一局、只改一个变量）：
//
//   | 变体 | 结果 |
//   |---|---|
//   | 旧结构（顶层平铺，无 examVO/userInfos） | 400 |
//   | + 嵌套 examVO，userInfos=[]            | 400 |
//   | 有嵌套 examVO + userInfos=[对手]        | **200 并结算** |
//   | 去掉嵌套 examVO（其余保留）             | 400 |
//   | 去掉 updatedTime（其余保留）            | 200（非必需，H5 会带，保留） |
//
// ⚠️ `userInfos` 的元素必须是 `{ userInfo: {...} }`（**包一层**）：
//    直接放 `{userId,userName,...}` 会 400（服务端 DTO 是 `List<OpponentVO>`）。
//    这一条与 H5 源码的 `.map(o => o.userInfo)` 写法不一致，但实测以服务端为准。
//
// 每题 = 原始 question 深拷贝 + 补字段；`script` = JSON.stringify(pathPoints)（两处同源）。
//
// 笔迹（stroke）：服务端回放笔迹做一致性检查，比较类题用普通字形会被判可疑；
// 这里移植「密集弧线」模板：`<` 用左弧、`>` 用右弧，坐标画布像素，每题抖动+平移。

const { PK } = require('./config');
const leo = require('./leo');
const strokes = require('./strokes');
const chain = require('./pk-chain');

/** 每题 costTime 下限（毫秒）。0ms 明显不自然。 */
const MIN_COST_TIME_MS = 5;

/**
 * `costTime` 的**服务端下限**（★ 2026-10-20 实测）。
 *
 * 提交体的 `costTime` 不能随便填小：10 题声明 100/200/500 一律 400，
 * 声明 1000 才 200（同一局、同一时刻、只改这一个字段）。
 *
 * 真机 H5 填的是 `结束时间 - 开始时间`（真实耗时），所以**生产路径直接用实测耗时**
 * （见 [runOneRound]）；下面两个常量只给「没传 costTimeMs」的工具/自检兜底。
 */
const DEFAULT_COST_TIME_PER_Q_MS = 100;
const DEFAULT_COST_TIME_FLOOR_MS = 1000;

/**
 * 兼容旧调用：生成一题的笔迹点集。
 *
 * @param {string} answer 正确答案
 * @param {number} seed   题号，保证可复现
 * @param {string} [strokeMode] `ARC`（默认）/ `SEVEN_SEGMENT`
 * @returns {Array<Array<{x:number,y:number}>>}
 */
function makePath(answer, seed, strokeMode) {
  return strokes.buildPathPoints(answer, seed, strokeMode).strokes;
}

/**
 * 组装提交 body（全对秒结算）。
 *
 * 返回结构 = H5 `result.html` 的真实提交体（见文件头注释）：
 *
 * ```js
 * {
 *   ...examVO 字段,            // pkIdStr/pointId/pointName/ruleType/questionCnt/correctCnt/costTime
 *   questions,                 // 作答后的题目
 *   updatedTime,               // 提交时刻（ms）
 *   triggerPeakMatch,          // 透传出题响应的值（缺省 0）
 *   examVO: { ...同一份 },      // ★ 嵌套副本，服务端要求
 *   userInfos: [{ userInfo }], // ★ 对手（包一层），服务端要求非空
 * }
 * ```
 *
 * @param {object} match       出题响应 JSON（含 pkIdStr / examVO / otherUser）
 * @param {object} [opts]
 * @param {number} [opts.costTimeMs] 整卷耗时；缺省按题数 × 下限
 * @param {number} [opts.seedBase]   笔迹随机种子基数
 * @param {string} [opts.strokeMode] 画笔算法：`ARC`（默认）/ `SEVEN_SEGMENT`
 * @param {number} [opts.updatedTimeMs] 覆盖 `updatedTime`（实验用）
 * @returns {object} 待加密的明文 body
 */
function buildSubmitBody(match, opts = {}) {
  const pkIdStr = match && match.pkIdStr;
  const examVO = match && match.examVO;
  if (!pkIdStr) throw new Error('出题响应缺 pkIdStr');
  if (!examVO) throw new Error('出题响应缺 examVO');
  const questions = examVO.questions;
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('出题响应缺 questions');

  const seedBase = opts.seedBase == null ? Math.floor(Math.random() * 1e9) : opts.seedBase;
  const strokeMode = strokes.normalizeStrokeMode(opts.strokeMode);

  const outQuestions = questions.map((q, idx) => {
    const answer = pickAnswer(q);
    // 笔迹按模式生成；ARC 遇到非 `>`/`<` 会自动回落七段码（见 strokes.js）
    const pathPoints = makePath(answer, seedBase + idx, strokeMode);
    const script = JSON.stringify(pathPoints);
    return {
      id: q.id == null ? 0 : q.id,
      examId: q.examId == null ? 0 : q.examId,
      content: q.content == null ? null : q.content,
      answer: q.answer == null ? null : q.answer,
      userAnswer: answer,
      answers: q.answers == null ? null : q.answers,
      status: 1,                 // 1 = 答对
      script: script,
      wrongScript: null,
      ruleType: q.ruleType == null ? null : q.ruleType,
      errorState: q.errorState == null ? 0 : q.errorState,
      curTrueAnswer: {
        recognizeResult: answer,
        pathPoints: pathPoints,
        answer: 1,
        showReductionFraction: 0,
      },
    };
  });

  const questionCnt = outQuestions.length;
  const cost = opts.costTimeMs == null
    ? Math.max(questionCnt * DEFAULT_COST_TIME_PER_Q_MS, DEFAULT_COST_TIME_FLOOR_MS)
    : Math.max(Number(opts.costTimeMs), MIN_COST_TIME_MS);
  const updatedTime = opts.updatedTimeMs == null ? Date.now() : Number(opts.updatedTimeMs);

  // 内层卷：旧版顶层结构 + updatedTime / triggerPeakMatch（H5 是直接展开 examVO）
  const inner = {
    pkIdStr: pkIdStr,
    pointId: examVO.pointId == null ? 0 : examVO.pointId,
    pointName: examVO.pointName == null ? null : examVO.pointName,
    ruleType: examVO.ruleType == null ? 0 : examVO.ruleType,
    questionCnt: questionCnt,
    correctCnt: questionCnt,     // 全对
    costTime: cost,
    questions: outQuestions,
    updatedTime: updatedTime,
    triggerPeakMatch: examVO.triggerPeakMatch == null ? 0 : examVO.triggerPeakMatch,
  };

  return Object.assign({}, inner, {
    examVO: inner,
    userInfos: opponentUserInfos(match),
  });
}

/**
 * 从出题响应里取对手列表，转成提交体要求的 `[{ userInfo }]`。
 *
 * 兼容三种来源（按优先级）：
 *   1. `examVO.opponents` / 顶层 `opponents`（多玩法，元素已是 `{ userInfo }` 或裸 userInfo）
 *   2. `otherUser`（1v1 的对手，服务端在顶层给）
 *
 * ⚠️ **必须非空**：实测 `userInfos: []` → 400。取不到对手时照原样返回空数组
 * （由服务端报错，日志里能看到 body，便于排查），不要在这里抛异常打断整轮。
 *
 * @param {object} match 出题响应
 * @returns {Array<{userInfo: object}>}
 */
function opponentUserInfos(match) {
  const raw = [];
  const examVO = match && match.examVO;
  if (examVO && Array.isArray(examVO.opponents)) raw.push.apply(raw, examVO.opponents);
  if (match && Array.isArray(match.opponents)) raw.push.apply(raw, match.opponents);
  if (match && match.otherUser) raw.push({ userInfo: match.otherUser });

  const out = [];
  const seen = new Set();
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const ui = it.userInfo && typeof it.userInfo === 'object' ? it.userInfo : it;
    const key = String(ui.userId == null ? '' : ui.userId) + '|' + String(ui.userName == null ? '' : ui.userName);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ userInfo: ui });
  }
  return out;
}

/** 从题目里挑「正确答案」：优先 `answer`，退回 `answers[0]`。 */
function pickAnswer(q) {
  if (q && q.answer != null && String(q.answer) !== '') return String(q.answer);
  if (q && Array.isArray(q.answers) && q.answers.length > 0) return String(q.answers[0]);
  return '';
}

/** 判断一次 HTTP 结果是不是频控/风控。 */
function isRateLimited(status, text) {
  if (status === 429 || status === 403) return true;
  const t = String(text || '');
  return t.includes('频繁') || t.includes('rate') || t.includes('blocked');
}

/**
 * 判断是不是「账号被平台限制」（不是频控，重试没有意义）。
 *
 * ★ 2026-10-20 实测：被限的账号出题返回
 * `400 {"status":400,"message":"No message available"}` —— 与频控的
 * `400 {"status":400,"message":"请求过于频繁"}` 是两回事，用户实测是 **24 小时**量级。
 *
 * 按频控去重试只会白等 2 分钟，还可能把处罚拖长，所以遇到这个直接判失败。
 */
function isAccountLimited(status, text) {
  if (status !== 400 && status !== 403) return false;
  const t = String(text || '');
  return t.includes(PK.accountLimitedText) ||
    t.includes('not available') || t.includes('已封禁');
}

/** 频控等待时长：base × 2^n，n 从 0 开始。 */
function backoffMs(attempt) {
  return PK.rateLimitBaseMs * Math.pow(2, Math.max(0, attempt));
}

/**
 * 跑一局：出题 → 组装 → 提交。
 *
 * @param {object} jar          已登录的 [leo.CookieJar]
 * @param {object} cfg          刷局配置
 * @param {number} cfg.pointId  知识点 ID
 * @param {number} [cfg.costTimeMs] 提交体里声明的整卷耗时。**留空 = 用真实耗时**
 *        （出题成功 → 提交时刻，即真机 H5 的口径）。填小于服务端下限会被 400。
 * @param {number} [cfg.rateLimitBaseMs] 覆盖默认退避基数
 * @param {number} [cfg.rateLimitMaxWait] 覆盖默认最大等待次数
 * @param {number} [cfg.gapMinMs] [cfg.gapMaxMs] 出题前随机间隔（降低频控概率）
 * @param {(ev:object)=>void} [onEvent] 事件回调（写日志/UI 用）
 * @returns {Promise<{ok:boolean, httpCode:number, message:string, detail:string, pkIdStr?:string, costTimeMs?:number, encryptedBytes?:number}>}
 */
async function runOneRound(jar, cfg, onEvent, ctx) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const signal = ctx && ctx.signal;
  const t0 = Date.now();
  const anySignal = (o) => (signal ? Object.assign({}, o, { signal: signal }) : o);
  const ensureLive = () => {
    if (signal && signal.aborted) throw abortedError();
  };

  // 1) 轮间隔（**唯一的节奏旋钮**）
  //
  // ⚠️ 这段等待期间日志必须**有东西可看**，否则前端会以为卡死：
  // 长间隔里没有事件的话，用户看到的就是一片空白。所以每 5 秒发一个 tick。
  //
  // ## 节奏由用户填，不由引擎强制（2026-10-01）
  //
  // 服务端**确实**有 ≈60s 的账号级出题冷却（见 config.js 的实测表），
  // 但按要求引擎**不强制**替你等 —— 网页上「每轮最小/最大间隔」填多少就按多少跑
  // （网页默认填 60000/65000，并写明「建议设 60 秒」）。
  //
  // 只有 [PK.matchCooldownMs] > 0 时才启用下面这段「贴冷却下沿」的自动配速：
  //
  //   等 = max(配置的轮间隔, 上次成功出题 + 冷却 - 现在)
  //
  // ctx 里带着**同账号**上一次成功出题的时刻（跨轮/跨任务共享），
  // 所以连续刷局时不会每次都白撞窗口、也不会多等。默认关闭（= 0）。
  const gapMin = num(cfg.gapMinMs, 0);
  const gapMax = num(cfg.gapMaxMs, 0);
  const gap = gapMin + Math.floor(Math.random() * Math.max(1, gapMax - gapMin));

  let cooldownWait = 0;
  if (ctx && ctx.lastMatchOkAt && PK.matchCooldownMs > 0) {
    const target = ctx.lastMatchOkAt + PK.matchCooldownMs - num(cfg.matchCooldownSafetyMs, PK.matchCooldownSafetyMs);
    cooldownWait = Math.max(0, target - Date.now());
  }
  const wait = Math.max(gap, cooldownWait);
  if (wait > 0) {
    const why = cooldownWait > gap
      ? `按出题冷却（${(PK.matchCooldownMs / 1000).toFixed(1)}s/账号）等 ${(wait / 1000).toFixed(1)}s 后出题`
      : `等待 ${(wait / 1000).toFixed(1)}s 后尝试下一局`;
    emit({ type: 'gap', message: why, gapMs: Math.round(wait) });
    // 可中断：点「立即结束」时不用等这段等待走完
    await sleepWithTicks(wait, (leftMs) => {
      emit({ type: 'tick', message: `距下轮还有 ${Math.ceil(leftMs / 1000)}s`, leftMs: leftMs });
    }, signal);
  }
  ensureLive();

  // 2) 出题 —— **遇频控自动等待重试**（对齐真机：点「继续PK」立刻下一局）
  //
  // 真机点「继续PK」是立刻请求的；如果撞上频控，真人会等一会儿再点。
  // 本引擎把这件「等一会儿再点」自动化：
  //   · 拿到 200 → 继续
  //   · 撞频控（400 请求过于频繁 / 403）→ 报一次日志，等 intervalMs 再试，直到超时
  //   · 撞非频控错误 → 立刻失败，不浪费时间
  //
  // 这样配置里那个「轮间隔」就只是**下限**（保护服务器、也让节奏像真人），
  // 而不需要用户去猜一个刚好大于频控窗口的数 —— 猜小了会白跑一局，
  // 猜大了又白白拖慢。
  const matchMaxWaitMs = num(cfg.matchRetryMaxMs, 2 * 60 * 1000);
  const matchIntervalMs = num(cfg.matchRetryIntervalMs, 10_000);
  emit({ type: 'match', message: `出题 pointId=${cfg.pointId}` });

  // ★ 2026-10-20：**每轮换一条设备链**（出题冷却按 `ks_deviceid` 算，不按账号）。
  //
  // 见 src/pk-chain.js 的实测表：同链 60s 内二次出题必 400，换链立刻 200。
  // 这里在出题前换，**整轮（出题 → 提交）用同一条链**，提交期间不再动 jar。
  const rotateEnabled = cfg.rotateChain == null ? PK.rotateChain !== false : cfg.rotateChain !== false;
  const triedChains = new Set();     // 本局已经撞过 400 的链，换链时排除
  let chainId = null;
  if (rotateEnabled) {
    const picked = chain.rotate(jar, { exclude: triedChains });
    if (picked) {
      chainId = picked.id;
      emit({ type: 'chain', message: `设备链 → #${picked.id}（${picked.deviceId || '?'}）` });
    } else {
      emit({ type: 'chain', message: '设备链池暂无空闲链，沿用当前链（可能需要等冷却）' });
    }
  }

  let m = null;
  /** 出题成功时刻（= 真机 H5 的 `startTime`），用于算提交体的 `costTime`。 */
  let matchOkAt = 0;
  {
    const tMatch = Date.now();
    let tries = 0;
    for (;;) {
      // 改用 v2（原版 App 在用的接口）：v2 返回加密响应，由 leo.pkMatchV2 内部用 keystream 解开。
      m = await leo.pkMatchV2(jar, cfg.pointId, anySignal({}));
      tries++;
      if (m.status === 200 && m.json) break;

      // ★ 账号被平台限制（No message available，用户实测 24h 量级）：
      //   这不是频控，重试没有意义，直接判失败让上层停掉这个账号。
      if (isAccountLimited(m.status, m.text)) {
        return fail(m.status,
          '该账号被平台限制（HTTP 400 No message available）—— 通常 24 小时后恢复，' +
          '本轮不再重试（重试只会白等，还可能把处罚拖长）',
          m.text, t0);
      }

      // 非频控错误：没必要重试
      if (!isRateLimited(m.status, m.text)) {
        return fail(m.status, `出题失败 HTTP ${m.status}`, m.text, t0);
      }
      const waited = Date.now() - tMatch;
      if (waited >= matchMaxWaitMs) {
        return fail(m.status,
          `出题持续频控（已重试 ${tries} 次 / ${Math.round(waited / 1000)}s 仍未放行）`,
          m.text, t0);
      }

      // ★ 撞冷却 → **换一条链立刻重试**（这才是正确解法，不是干等 60s）。
      let rotated = null;
      if (rotateEnabled) {
        if (chainId != null) triedChains.add(chainId);
        rotated = chain.rotate(jar, { exclude: triedChains });
        if (rotated) chainId = rotated.id;
      }
      if (rotated) {
        const gap = num(cfg.chainRetryIntervalMs, PK.chainRetryIntervalMs);
        emit({
          type: 'rate-limit',
          message: `出题被频控（HTTP ${m.status}）→ 换设备链 #${rotated.id}` +
            `（${rotated.deviceId || '?'}）后重试（已重试 ${tries} 次 / ${Math.round(waited / 1000)}s）`,
        });
        await sleepWithTicks(gap, (leftMs) => {
          emit({ type: 'tick', message: `换链重试倒计时 ${Math.ceil(leftMs / 1000)}s`, leftMs: leftMs });
        }, signal);
        ensureLive();
        continue;
      }

      // 池里没有别的链可用 → 退回「等一会儿再试」
      emit({
        type: 'rate-limit',
        message: `出题被频控（HTTP ${m.status}）且无可换设备链，${Math.round(matchIntervalMs / 1000)}s 后重试（已等 ${Math.round(waited / 1000)}s）`,
      });
      await sleepWithTicks(matchIntervalMs, (leftMs) => {
        emit({ type: 'tick', message: `出题重试倒计时 ${Math.ceil(leftMs / 1000)}s`, leftMs: leftMs });
      }, signal);
      ensureLive();
    }
    // 这条链刚被用于出题 → 记时间戳，65s 内不再选它
    if (chainId != null) chain.markUsed(chainId, Date.now());
    emit({ type: 'match-ok', message: `出题成功：pkIdStr=${m.json.pkIdStr}，共 ${((m.json.examVO && m.json.examVO.questions) || []).length} 题（第 ${tries} 次尝试）` });
    // 记下这次成功时刻（**按账号**共享）→ 下一轮据此贴冷却下沿发车
    matchOkAt = Date.now();
    if (ctx) ctx.lastMatchOkAt = matchOkAt;
  }
  const pkIdStr = m.json.pkIdStr;
  const qCount = (m.json.examVO && m.json.examVO.questions) ? m.json.examVO.questions.length : 0;

  // 2.5) 拿到题目 → 提交答案 之间的间隔（可配）
  //
  // 真人是「看一眼题、写答案、再交卷」，不是秒交。这里给一段可配的等待，
  // 让提交节奏更自然（也顺便错开频控窗口）。
  const dMin = num(cfg.submitDelayMinMs, 8000);
  const dMax = num(cfg.submitDelayMaxMs, 12000);
  if (dMax > 0 || dMin > 0) {
    const lo = Math.min(dMin, dMax);
    const hi = Math.max(dMin, dMax);
    const delay = lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
    if (delay > 0) {
      emit({ type: 'delay', message: `答题间隔：${(delay / 1000).toFixed(1)}s 后提交` });
      await sleepWithTicks(delay, (leftMs) => {
        emit({ type: 'tick', message: `距提交还有 ${Math.ceil(leftMs / 1000)}s`, leftMs: leftMs });
      }, signal);
      ensureLive();
    }
  }

  // 3) 组装 + 提交（含频控退避）
  const maxWait = num(cfg.rateLimitMaxWait, PK.rateLimitMaxWait);
  const strokeLabel = strokes.STROKE_MODE_LABELS[strokes.normalizeStrokeMode(cfg.strokeMode)];
  let attempt = 0;
  for (;;) {
    let bodyObj;
    try {
      // ★ `costTime` 缺省用**真实耗时**（出题成功 → 现在）。
      //
      // 真机 H5 交的就是「结束时间 - 开始时间」；服务端会校验这个值不能太小
      // （实测 10 题：100/200/500 全 400，1000 才 200）。
      // 旧代码缺省填 `题数 × 5ms`（10 题 = 50ms）→ 2026-10 中旬起必 400。
      const elapsedMs = matchOkAt > 0 ? Date.now() - matchOkAt : null;
      bodyObj = buildSubmitBody(m.json, {
        costTimeMs: cfg.costTimeMs == null ? elapsedMs : cfg.costTimeMs,
        seedBase: (Date.now() % 1e9) + attempt,
        strokeMode: cfg.strokeMode,
      });
    } catch (e) {
      return fail(m.status, '组装提交体失败：' + e.message, '', t0);
    }

    // 4) 加密（会起 native 进程，约 80~250ms）
    emit({ type: 'encode', message: `加密提交体（画笔算法：${strokeLabel}）` });
    let cipher;
    try {
      cipher = require('./native').encodeSubmitBody(Buffer.from(JSON.stringify(bodyObj), 'utf8'));
    } catch (e) {
      return fail(null, '内容编码失败：' + e.message, '', t0);
    }
    emit({ type: 'encode-ok', message: `加密完成：明文 ${Buffer.byteLength(JSON.stringify(bodyObj))}B → 密文 ${cipher.length}B` });

    // 5) 提交
    emit({ type: 'submit', message: `提交（第 ${attempt + 1} 次）costTime=${bodyObj.costTime}ms 全对 ${bodyObj.correctCnt}/${bodyObj.questionCnt}` });
    const s = await leo.pkSubmitRaw(jar, cipher, anySignal({}));
    if (s.status === 200) {
      // ⚠️ 提交 200 ≠ 这局已结算。MUST 再拉一次结算接口核对
      // （真机上这是结算页 result.html 的数据源，见 leo.pkHistoryDetail 注释）。
      // 没结算成功的局在服务端是 {correctCnt:0, questions:null} 的占位记录。
      const settle = await confirmSettle(jar, pkIdStr, bodyObj, emit, signal);
      if (!settle.ok) {
        return {
          ok: false,
          httpCode: 200,
          message: settle.message,
          detail: settle.raw,
          pkIdStr: pkIdStr,
          costTimeMs: Date.now() - t0,
        };
      }
      return {
        ok: true,
        httpCode: 200,
        message: settle.message,
        detail: JSON.stringify(settle.detail).slice(0, 2000),
        pkIdStr: pkIdStr,
        settled: settle.detail,
        costTimeMs: Date.now() - t0,
      };
    }

    if (isRateLimited(s.status, s.text) && attempt < maxWait) {
      const wait = backoffMs(attempt) * (num(cfg.rateLimitBaseMs, PK.rateLimitBaseMs) / PK.rateLimitBaseMs);
      emit({ type: 'rate-limit', message: `HTTP ${s.status} 频控，退避 ${(wait / 1000).toFixed(0)}s 后重试` });
      await sleepWithTicks(wait, (leftMs) => {
        emit({ type: 'tick', message: `退避中，还剩 ${Math.ceil(leftMs / 1000)}s`, leftMs: leftMs });
      }, signal);
      ensureLive();
      attempt++;
      continue;
    }
    return fail(s.status, `提交失败 HTTP ${s.status}`, s.text, t0, pkIdStr);
  }
}

/**
 * 提交后核对结算（对齐结算页 `result.html?pkIdStr=X` 的数据源）。
 *
 * 返回 `{ok, message, detail}`：
 *  - `ok:true`  服务端已有逐题明细（`correctCnt > 0` 且 `questions` 非空）
 *  - `ok:false` 仍是 `{correctCnt:0, questions:null}` 的占位记录 → 这局没算上
 *
 * 只读接口，**不计入出题频控**，所以可以放心在每轮都调。
 */
async function confirmSettle(jar, pkIdStr, sentBody, emit, signal) {
  const r = await leo.pkHistoryDetail(jar, pkIdStr, { signal: signal });
  const j = r.json;
  if (r.status !== 200 || !j) {
    emit({ type: 'settle', message: `结算核对失败 HTTP ${r.status}（提交本身已是 200）` });
    // 结算接口查不到不代表这局一定失败：可能只是历史还没落库。
    // 此时按「提交成功」记账，但把情况写进 detail，不误报失败。
    return {
      ok: true,
      message: `提交成功（结算明细未取到，HTTP ${r.status}）`,
      detail: { settled: false, reason: 'history/detail ' + r.status, sent: sentBody.correctCnt },
      raw: String(r.text || '').slice(0, 500),
    };
  }
  const cnt = Number(j.correctCnt) || 0;
  const qs = Array.isArray(j.questions) ? j.questions.length : 0;
  if (cnt > 0 && qs > 0) {
    emit({ type: 'settle-ok', message: `已结算：答对 ${cnt} 题 / 明细 ${qs} 题` });
    return {
      ok: true,
      message: `提交成功并已结算（对 ${cnt} 题）`,
      detail: {
        settled: true, correctCnt: cnt, questionCnt: Number(j.questionCnt) || qs,
        pointId: j.pointId, pointName: j.pointName, costTime: j.costTime,
      },
    };
  }
  emit({ type: 'settle-fail', message: `服务端未结算（correctCnt=${cnt}, questions=${j.questions === null ? 'null' : qs}）—— 这局没算上` });
  return {
    ok: false,
    message: `提交返回 200 但未被结算（correctCnt=${cnt}）`,
    detail: JSON.stringify(j).slice(0, 600),
    raw: String(r.text || '').slice(0, 600),
  };
}

/** 中断错误：`aborted === true`，上层据此把任务标成 stopped 而不是 failed。 */
function abortedError() {
  const e = new Error('任务已被手动结束');
  e.aborted = true;
  return e;
}

function fail(status, message, detail, t0, pkIdStr) {
  return {
    ok: false,
    httpCode: status,
    message: message,
    detail: String(detail || '').slice(0, 2000),
    pkIdStr: pkIdStr,
    costTimeMs: Date.now() - t0,
  };
}

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带「滴答」的长睡眠：每 5 秒回调一次剩余毫秒；**可被 signal 立即中断**。
 *
 * 用途：轮间隔 / 答题间隔 / 频控退避期间既给前端发心跳（避免日志空白），
 * 又能让「立即结束」不用等这段等待走完。
 *
 * @param {number} ms
 * @param {(leftMs:number)=>void} onTick
 * @param {AbortSignal} [signal] 中断信号
 */
async function sleepWithTicks(ms, onTick, signal) {
  const total = Math.max(0, Number(ms) || 0);
  const TICK = 5000;
  let left = total;
  while (left > 0) {
    if (signal && signal.aborted) throw abortedError();
    const step = Math.min(TICK, left);
    // eslint-disable-next-line no-await-in-loop
    await sleepAbortable(step, signal);
    left -= step;
    // left === 0 时不回报：说「还剩 0s」没有意义，下一行就是实际动作了
    if (left <= 0) break;
    try { onTick(left); } catch (e) { /* 回调异常不影响任务 */ }
  }
}

/**
 * 可中断的 sleep：signal 触发时**立刻** reject，不等睡满。
 *
 * 这是「立即结束」的关键 —— 否则点停止后要等最长 20s 的轮间隔才停。
 */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortedError());
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortedError());
    }
    if (signal) {
      if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      else signal.once('abort', onAbort);   // 兼容只有 once 的实现
    }
  });
}

module.exports = {
  MIN_COST_TIME_MS,
  makePath,
  buildSubmitBody,
  opponentUserInfos,
  pickAnswer,
  isRateLimited,
  isAccountLimited,
  backoffMs,
  runOneRound,
};