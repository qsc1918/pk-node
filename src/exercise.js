'use strict';
/**
 * 练习（`/leo-star` `/leo-math`）协议层，与 PK 是两条独立链路。
 * 练习必须用 `version=3.140.1` + `platform=android37`（否则主域 417），sign 由原生库算。
 */

const { config, PK } = require('./config');
const { request } = require('./http');
const nativeLib = require('./native');

/** 练习专用公共参数（在 PK 里，见 config.js 的 PK.exercise）。 */
const EX = PK.exercise;
const keystream = require('./keystream');
const strokes = require('./strokes');

/* ------------------------------------------------------------------ 工具 */

/** 20 位 [a-z0-9] traceId（原版形态）。 */
function randomTraceId() {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 20; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

/**
 * 练习专用请求头：相比 PK，必须带 `leo-client-trace-id` 与 `default-namespace-sw8`（主域风控会看）。
 */
function exerciseHeaders(extra, traceId) {
  const tid = traceId || randomTraceId();
  const h = Object.assign(
    {
      'leo-client-trace-id': tid,
      'default-namespace-sw8': leo_sw8(tid),
      'User-Agent': exerciseUa(),
      'X-XYKS-REQ-TIMESTAMP': String(Date.now()),
      'X-XYKS-REQ-NETWORK-ENV': 'mobile',
      'x-shepherd-sessionid': '0',
    },
    PK.headers,
    extra || {},
  );
  if (config.shepherdDid) h['x-shepherd-did'] = config.shepherdDid;
  return h;
}

/** `MQ==-<b64(traceId)>-MA==-0-X19PX1JfVF9f-UF9J-UF9F-SV9Q`（原版逐字）。 */
function leo_sw8(traceId) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  return b64('1') + '-' + b64(traceId) + '-' + b64('0') + '-0-X19PX1JfVF9f-UF9J-UF9F-SV9Q';
}

/** `Leo/3.140.1 (Redmi25053RT47C; Android 17; Scale/3.25)` —— 版本必须与 query 一致。 */
function exerciseUa() {
  const d = config.device;
  // ⚠️ UA 的 Android 版本是 17（原版逐字），不是 SDK 号 37；用 37 会被风控识别成异构请求（417）。
  return 'Leo/' + EX.version +
    ' (' + d.brand + d.model + '; Android ' + (d.uaSdk || 17) + '; Scale/' + d.scale + ')';
}

/**
 * 拼练习 URL：`_productId` 最前、`sign` 最后（按原版顺序）。
 * sign 由原生库算（纯 JS 不可复现），算不出就不带——练习实测不需要它。
 */
function buildExerciseUrl(path, params) {
  const q = [['_productId', EX.productId]];
  for (const k of ['platform', 'version', 'vendor', 'deviceCategory', 'av', 'webviewVersion', 'whRatio', 'isBackground']) {
    q.push([k, EX[k]]);
  }
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    q.push([k, String(v)]);
  }
  const sign = maybeSign(path);
  if (sign) q.push(['sign', sign]);
  return config.leoBase + path + '?' + q.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

/**
 * 练习端点的签名策略：一律带 sign（不受 `config.signMode` 影响）。
 * 不带 sign → 417（solar-encoder 拦）；sign 由原生库算，算不出返回 null（端点会 417 但 UI 可见响应）。
 */
function maybeSign(path) {
  try {
    // 练习走「练习版」签名资产（variant: 'exercise'，配 version=3.140.1）
    return nativeLib.calcSign(path, { variant: 'exercise' });
  } catch (e) {
    // 算不出来 → 不带。此时练习端点会 417，
    // 但至少不抛异常，UI 能看到明确的服务端响应。
    return null;
  }
}

function safeJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }

/** 表单编码（`a=1&b=2`）。 */
function form(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => k + '=' + encodeURIComponent(String(v)))
    .join('&');
}

/* ------------------------------------------------------------ 读类端点 */

/** `GET /leo-star/android/exercise/homepage` —— 周经验 / 今日积分 / 倍数。 */
async function homepage(jar, opts) {
  const r = await request({
    url: buildExerciseUrl('/leo-star/android/exercise/homepage'),
    method: 'GET', jar, signal: opts && opts.signal, headers: exerciseHeaders(),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/**
 * `GET /leo-star/android/exercise/rank/pre-fetch` —— **分数的权威读数**。
 *
 * 上报经验后用它前后的 `curWeekScore` 差值，才知道服务端**实际入账**了多少。
 */
async function rankPrefetch(jar, opts) {
  const r = await request({
    url: buildExerciseUrl('/leo-star/android/exercise/rank/pre-fetch'),
    method: 'GET', jar, signal: opts && opts.signal, headers: exerciseHeaders(),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/** `GET /leo-star/android/exercise/item/status` —— 奖励道具（如「三倍奖励」）。 */
async function itemStatus(jar, opts) {
  const r = await request({
    url: buildExerciseUrl('/leo-star/android/exercise/item/status'),
    method: 'GET', jar, signal: opts && opts.signal, headers: exerciseHeaders(),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/** `GET /leo-star/android/exercise/task/home` —— 今日任务。 */
async function taskHome(jar, opts) {
  const r = await request({
    url: buildExerciseUrl('/leo-star/android/exercise/task/home'),
    method: 'GET', jar, signal: opts && opts.signal, headers: exerciseHeaders(),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/** 一次读全（UI 一次刷新拿齐）。 */
async function overview(jar) {
  const out = { ok: true };
  const hp = await homepage(jar);
  if (hp.status !== 200) { out.ok = false; out.error = 'homepage HTTP ' + hp.status; return out; }
  const d = (hp.json && hp.json.data) || {};
  out.curWeekExp = d.curWeekExp;
  out.todayObtainedPoints = d.todayObtainedPoints;
  out.nextMultiplier = d.nextMultiplier;
  out.continuousDays = d.continuousDays;
  out.curRank = d.curRank;

  const pf = await rankPrefetch(jar);
  if (pf.status === 200 && pf.json && pf.json.data) {
    out.curWeekScore = pf.json.data.curWeekScore;
    out.expectedMultiple = pf.json.data.expectedMultiple;
  }
  const it = await itemStatus(jar);
  if (it.status === 200 && it.json) out.item = it.json.item || null;
  const th = await taskHome(jar);
  if (th.status === 200 && th.json) out.tasks = th.json.taskRecords || [];
  return out;
}

/* -------------------------------------------------------------- 出题 */

/**
 * `GET /leo-math/android/exams/exercises/type/{type}` —— 知识点树。
 * ⚠️ `book` / `grade` / `semester` 三个都必填（缺哪个服务端就报哪个）。
 */
async function keypoints(jar, opts) {
  const o = opts || {};
  const path = '/leo-math/android/exams/exercises/type/' + (o.type == null ? 0 : o.type);
  const r = await request({
    url: buildExerciseUrl(path, {
      book: o.book == null ? 54 : o.book,
      grade: o.grade == null ? 1 : o.grade,
      semester: o.semester == null ? 1 : o.semester,
      count: o.count == null ? 10 : o.count,
    }),
    method: 'GET', jar, signal: o.signal, headers: exerciseHeaders(),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/**
 * `POST /leo-math/android/exams` —— 出一整套题。
 * body 是 form-urlencoded 的 `keypointId` + `limit`；返回 `questions[]` 每题自带 `answer`（「作答」= 抄答案）。
 * @returns {Promise<{status:number, json:object|null, text:string}>}
 */
async function getExam(jar, keypointId, limit, opts) {
  const path = '/leo-math/android/exams';
  const r = await request({
    url: buildExerciseUrl(path),
    method: 'POST',
    jar,
    body: form({ keypointId: String(keypointId), limit: String(limit == null ? 10 : limit) }),
    signal: opts && opts.signal,
    headers: exerciseHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/**
 * 提交整卷成绩：`PUT /leo-math/android/exams/{examId}`（旧路径，不是 /v2/），JSON 明文不编码。
 * 注意与 PK 区别：PK 提交必须 gzip+c()+octet-stream；练习必须 JSON 明文（编码纪律相反）。
 * 作答填 `userAnswer` / `status`(1对/-1错) / `costTime`（下限5ms）；`script`(笔迹) 不填也能过。
 * @returns {Promise<{status:number, json:object|null, text:string}>}
 */
async function submitExam(jar, examId, exam, opts) {
  const path = '/leo-math/android/exams/' + examId;
  const r = await request({
    url: buildExerciseUrl(path),
    method: 'PUT',
    jar,
    body: Buffer.from(JSON.stringify(exam), 'utf8'),
    signal: opts && opts.signal,
    headers: exerciseHeaders({ 'Content-Type': 'application/json' }),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/** `GET /leo-math/android/exams/{examId}` —— 拉回带批改的结果。 */
async function getExamResult(jar, examId, opts) {
  const r = await request({
    url: buildExerciseUrl('/leo-math/android/exams/' + examId),
    method: 'GET', jar, signal: opts && opts.signal, headers: exerciseHeaders(),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text };
}

/**
 * 本地「作答」：把每题填成全对，并生成笔迹（供服务端回放判卷）。
 * 服务端是「回放笔迹 + 识别」判卷，不信任客户端 `status` 字段（PK 同理）。
 * 笔迹复用 [strokes]：比较题（`>`/`<`/`=`）走弧线模板，其它回落七段码。
 * @param {object} exam 出题响应
 * @param {number} [costTimePerQuestionMs] 每题耗时（下限 5ms，真机纪律）
 */
function answerAll(exam, costTimePerQuestionMs) {
  const per = Math.max(5, Number(costTimePerQuestionMs) || 900);
  const questions = (exam.questions || []).map((q, idx) => {
    const answer = q.answer == null ? '' : String(q.answer);
    // 每题用不同 seed，避免笔迹完全雷同（服务端会比对）
    const pathPoints = strokes.buildPathPoints(answer, idx + 1, 'ARC').strokes;
    return Object.assign({}, q, {
      userAnswer: answer,
      status: 1,                              // 1 = 答对
      costTime: per,
      script: JSON.stringify(pathPoints),     // 服务端据此判卷
      curTrueAnswer: {
        recognizeResult: answer,
        pathPoints: pathPoints,
        answer: 1,
        showReductionFraction: 0,
      },
    });
  });
  return Object.assign({}, exam, {
    questions: questions,
    correctCnt: questions.length,
    costTime: per * questions.length,
  });
}

/* ---------------------------------------------------- 经验上报（刷分） */

/** 可记账的 `ruleType`（实测只有 0 和 1 会让 `curWeekScore` 真正增加）。 */
const PUMP_RULE_TYPES = [0, 1];

/** 单条 `obtainExp` 的服务端 clamp 上限（发更多也只记这么多）。 */
const PER_ITEM_MAX = 200;

/**
 * `POST /leo-star/android/exercise/rank/login/attend` —— 经验上报（刷分）。
 * body 是**增量**上报：`obtainExp`=本次获得经验，服务端累加到周分数（不是设置总分）。
 * 带 `@NeedEncode`：必须 gzip+c() 且 Content-Type: octet-stream；明文直接发→500，编码后→200。
 * 每个可记账 `ruleType` 每天只记一次（同 ruleType 第二次静默丢弃），日上限 = 200×|ruleTypes|。
 * @param {number} delta   本次增量（会被服务端 clamp 到 [PER_ITEM_MAX]）
 * @param {number} ruleType 见 [PUMP_RULE_TYPES]
 * @returns {Promise<{status:number, json:object|null, text:string}>}
 */
async function attend(jar, delta, ruleType, opts) {
  const path = '/leo-star/android/exercise/rank/login/attend';
  const body = {
    todayExercises: [{
      finishTime: Date.now(),
      obtainExp: Math.max(1, Math.round(Number(delta) || PER_ITEM_MAX)),
      ruleType: Number(ruleType) || 0,
    }],
  };
  let cipher;
  try {
    cipher = nativeLib.encodeSubmitBody(Buffer.from(JSON.stringify(body), 'utf8'));
  } catch (e) {
    return { status: null, text: '编码失败：' + e.message, error: true };
  }
  const r = await request({
    url: buildExerciseUrl(path),
    method: 'POST', jar, body: cipher,
    signal: opts && opts.signal,
    headers: exerciseHeaders({ 'Content-Type': 'application/octet-stream' }),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text, sent: body.todayExercises[0] };
}

/** 读当前周分数（记账核对用）。 */
async function readScore(jar) {
  const r = await rankPrefetch(jar);
  const j = r.json;
  return (j && j.data && j.data.curWeekScore != null) ? j.data.curWeekScore : null;
}

/**
 * 「刷分」：对每个可记账 ruleType 各上报一次，以服务端入账为准返回。
 * 按 ruleType 遍历（同 ruleType 每天去重，发多条并不加分）；不同 ruleType 各记一笔才是原版语义。
 * @param {(ev:object)=>void} [onEvent] 进度回调
 * @param {AbortSignal} [signal]
 */
async function pumpScore(jar, opts) {
  const o = opts || {};
  const emit = typeof o.onEvent === 'function' ? o.onEvent : () => {};
  const delta = Math.min(PER_ITEM_MAX, Math.max(1, Number(o.delta) || PER_ITEM_MAX));
  const ruleTypes = Array.isArray(o.ruleTypes) && o.ruleTypes.length ? o.ruleTypes : PUMP_RULE_TYPES;

  const before = await readScore(jar);
  emit({ type: 'pump', message: `上报前 curWeekScore=${before}；将依次尝试 ruleType ${ruleTypes.join('/')}，每次 ${delta}` });
  const applied = [];
  let last = before;

  for (const rt of ruleTypes) {
    if (o.signal && o.signal.aborted) throw Object.assign(new Error('已取消'), { aborted: true });
    const r = await attend(jar, delta, rt, { signal: o.signal });
    if (r.status !== 200) {
      emit({ type: 'pump-fail', message: `ruleType=${rt} HTTP ${r.status} ${String(r.text).slice(0, 80)}` });
      applied.push({ ruleType: rt, status: r.status, gained: 0 });
      continue;
    }
    await sleep(900);
    const now = await readScore(jar);
    const gained = (now != null && last != null) ? now - last : 0;
    emit({
      type: gained > 0 ? 'pump-ok' : 'pump-skip',
      message: gained > 0
        ? `ruleType=${rt} 入账 +${gained}（curWeekScore=${now}）`
        : `ruleType=${rt} 服务端未增加（该类型今日已记过）`,
    });
    applied.push({ ruleType: rt, status: r.status, gained: gained });
    last = now;
  }

  const total = applied.reduce((s, a) => s + (a.gained || 0), 0);
  emit({ type: 'pump-done', message: `上报完成：本次共入账 +${total}（curWeekScore=${last}）` });
  return { ok: total > 0, before: before, after: last, gained: total, applied: applied };
}

/**
 * 练习出题冷却（毫秒）—— 每轮之间的下沿，不是硬上限。
 * 默认 1s（与安卓端 DEFAULT_COOLDOWN_MS 对齐），可用 PK_EX_MATCH_COOLDOWN_MS 覆盖。
 */
const MATCH_COOLDOWN_MS = Math.max(0, Number(process.env.PK_EX_MATCH_COOLDOWN_MS) || 1_500);
/** 撞 429 时的重试间隔 / 总等待上限。 */
const MATCH_RETRY_INTERVAL_MS = 10_000;
const MATCH_RETRY_MAX_MS = 4 * 60 * 1000;

/**
 * **完整练习闭环**：出题 → 抄答案 → 提交 → 拉回批改结果。
 * 出题有账号级冷却，撞到 429 自动重试（累计超上限判失败），调用方不必自己算窗口。
 * @param {number} keypointId 知识点 ID（默认 235001）
 * @param {number} limit      题数（口算可选 10/20/30/60/100）
 * @param {(ev:object)=>void} [onEvent]
 */
async function runPractice(jar, opts) {
  const o = opts || {};
  const emit = typeof o.onEvent === 'function' ? o.onEvent : () => {};
  const kp = o.keypointId == null ? 235001 : o.keypointId;
  const limit = o.limit == null ? 10 : o.limit;
  const live = () => { if (o.signal && o.signal.aborted) throw Object.assign(new Error('已取消'), { aborted: true }); };

  // 1) 出题（含 429 频控重试）
  live();
  emit({ type: 'ex-match', message: `出题 keypointId=${kp} limit=${limit}` });
  const tMatch = Date.now();
  let g = null, tries = 0;
  for (;;) {
    g = await getExam(jar, kp, limit, { signal: o.signal });
    tries++;
    if (g.status === 200 && g.json && g.json.idString) break;
    const rateLimited = g.status === 429 || /频繁|too_many/.test(String(g.text));
    if (!rateLimited) {
      emit({ type: 'ex-fail', message: `出题失败 HTTP ${g.status} ${String(g.text).slice(0, 90)}` });
      return { ok: false, stage: 'match', status: g.status, text: g.text };
    }
    const waited = Date.now() - tMatch;
    if (waited >= MATCH_RETRY_MAX_MS) {
      emit({ type: 'ex-fail', message: `出题持续频控（已试 ${tries} 次 / ${Math.round(waited / 1000)}s）` });
      return { ok: false, stage: 'match', status: g.status, text: g.text };
    }
    emit({
      type: 'ex-rate-limit',
      message: `出题被限流（HTTP 429），${MATCH_RETRY_INTERVAL_MS / 1000}s 后重试（已等 ${Math.round(waited / 1000)}s）`,
    });
    await sleep(MATCH_RETRY_INTERVAL_MS, o.signal);
    live();
  }

  const exam = g.json;
  emit({
    type: 'ex-match-ok',
    message: `出题成功 examId=${exam.idString} ${exam.keypoint} 共 ${exam.questionCnt} 题（预计 +${exam.questionCnt * 2} 经验）`,
  });

  // 2) 作答（抄答案 + 生成笔迹 —— 服务端靠笔迹判卷）
  live();
  const answered = answerAll(exam, o.costTimePerQuestionMs);
  emit({ type: 'ex-submit', message: `提交（全对 ${answered.correctCnt}/${answered.questionCnt}，含笔迹）` });
  const s = await submitExam(jar, exam.idString, answered, { signal: o.signal });
  if (s.status !== 200) {
    emit({ type: 'ex-fail', message: `提交失败 HTTP ${s.status} ${String(s.text).slice(0, 90)}` });
    return { ok: false, stage: 'submit', status: s.status, text: s.text, examId: exam.idString };
  }
  const res = s.json || {};
  const correct = Number(res.correctCnt) || 0;
  emit({
    type: 'ex-ok',
    message: `提交成功：服务端判对 ${correct}/${res.questionCnt || exam.questionCnt}，经验 +${correct * 2}`,
  });
  return {
    ok: true, examId: exam.idString, keypoint: exam.keypoint,
    questionCnt: res.questionCnt || exam.questionCnt,
    correctCnt: correct,
    exp: correct * 2,
    result: res,
  };
}

/**
 * **循环刷练习**：跑 N 轮「出题 → 抄答案 → 提交」，按出题冷却配速。
 * 记住上次成功出题时刻，下一轮等到「上次成功 + 冷却」再发车，避免白撞 429。
 * 冷却按「次」算不按题数，一次开 100 题比 10 题划算 10 倍（默认 limit=100）。
 * @param {(ev:object)=>void} [onEvent] 进度事件
 * @param {number} [rounds] 轮数
 * @param {number} [limit]  每局题数
 */
async function practiceLoop(jar, opts) {
  const o = opts || {};
  const emit = typeof o.onEvent === 'function' ? o.onEvent : () => {};
  const rounds = Math.max(1, Number(o.rounds) || 1);
  const limit = o.limit == null ? 100 : Number(o.limit);
  const kp = o.keypointId == null ? 235001 : o.keypointId;
  /**
   * 「每轮间隔」（UI 配置）：实际等待 = max(冷却剩余, 随机[gapMinMs, gapMaxMs])。
   * 冷却是硬下限（配更小也没用，会 429），之上再随机间隔避免固定节奏；
   * cooldownSafetyMs 是从冷却下沿往回退的安全边距。
   */
  const gapMin = Math.max(0, Number(o.gapMinMs) || 0);
  const gapMax = Math.max(gapMin, Number(o.gapMaxMs) || 0);
  // 安全边距：从冷却下沿往回退一点，避免贴着窗口边缘白撞 429（默认 200ms）。
  const safety = o.cooldownSafetyMs == null ? 200 : Math.max(0, Number(o.cooldownSafetyMs));
  const randGap = () => (gapMax > gapMin
    ? gapMin + Math.floor(Math.random() * (gapMax - gapMin + 1))
    : gapMin);

  let lastMatchOkAt = 0;
  let done = 0, failed = 0, totalExp = 0;
  let lastWaitMs = 0;

  for (let i = 1; i <= rounds; i++) {
    if (o.signal && o.signal.aborted) throw abortedError();

    // 每轮间隔：冷却剩余 与 随机间隔 取大者
    if (lastMatchOkAt) {
      const cooldownLeft = Math.max(0, lastMatchOkAt + MATCH_COOLDOWN_MS - safety - Date.now());
      const gap = randGap();
      const wait = Math.max(cooldownLeft, gap);
      lastWaitMs = wait;
      if (wait > 0) {
        emit({
          type: 'ex-gap',
          round: i,
          message: `间隔 ${(wait / 1000).toFixed(1)}s 后开始第 ${i} 轮` +
            `（配置 ${(gap / 1000).toFixed(1)}s，冷却剩 ${(cooldownLeft / 1000).toFixed(1)}s）`,
          configuredMs: gap,
          cooldownLeftMs: cooldownLeft,
          waitMs: wait,
        });
        // 可中断等待：点「停止」立刻退出，不用等这段间隔走完
        await sleep(wait, o.signal);
      }
    }

    emit({ type: 'ex-round', round: i, message: `第 ${i}/${rounds} 轮开始` });
    const t0 = Date.now();
    let r;
    try {
      r = await runPractice(jar, {
        keypointId: kp, limit: limit,
        costTimePerQuestionMs: o.costTimePerQuestionMs,
        signal: o.signal,
        onEvent: emit,
      });
    } catch (e) {
      if (e && e.aborted) throw e;
      r = { ok: false, status: null, text: '异常：' + e.message };
    }
    if (!r || !r.ok) {
      failed++;
      emit({
        type: 'ex-round-fail', round: i, status: (r && r.status) || null,
        message: `第 ${i} 轮失败：${(r && r.text || '').slice(0, 90)}`,
      });
      // 出题失败多半是还在冷却 → 补等一轮再继续
      await sleep(MATCH_RETRY_INTERVAL_MS, o.signal);
      continue;
    }
    done++;
    totalExp += r.exp || 0;
    lastMatchOkAt = Date.now();
    emit({
      type: 'ex-round-ok',
      round: i,
      correctCnt: r.correctCnt,
      questionCnt: r.questionCnt,
      exp: r.exp,
      examId: r.examId,
      message: `第 ${i} 轮成功：判对 ${r.correctCnt}/${r.questionCnt}，+${r.exp} 经验（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，累计 +${totalExp}）`,
    });
  }

  emit({ type: 'ex-done', message: `全部结束：成功 ${done}/${rounds}，累计经验 +${totalExp}` });
  return {
    ok: failed === 0, rounds: rounds, done: done, failed: failed, totalExp: totalExp,
    gapMinMs: gapMin, gapMaxMs: gapMax, lastWaitMs: lastWaitMs,
  };
}

/** 练习链路的频控/上限说明（给 UI 用，避免用户以为是 bug）。 */
function explainLimits() {
  return {
    pumpRuleTypes: PUMP_RULE_TYPES,
    perItemMax: PER_ITEM_MAX,
    dailyPumpCap: PER_ITEM_MAX * PUMP_RULE_TYPES.length,
    note: '经验上报按 ruleType 每天只记一次；实测可记账的只有 0 与 1，日上限 ' +
      (PER_ITEM_MAX * PUMP_RULE_TYPES.length) + ' 分。',
  };
}

/** 小睡：支持 AbortSignal，点「停止任务」时立刻退出而非等满等待。 */
function sleep(ms, signal) {
  const total = Math.max(0, Number(ms) || 0);
  if (!signal) return new Promise((r) => setTimeout(r, total));
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortedError());
    const timer = setTimeout(() => {
      if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      resolve();
    }, total);
    function onAbort() {
      clearTimeout(timer);
      reject(abortedError());
    }
    if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 中断错误：`aborted === true`，上层据此把任务标成 stopped 而不是 failed。 */
function abortedError() {
  const e = new Error('任务已被手动结束');
  e.aborted = true;
  return e;
}

module.exports = {
  // 头 / URL
  exerciseHeaders, buildExerciseUrl, exerciseUa, randomTraceId,
  // 读
  homepage, rankPrefetch, itemStatus, taskHome, overview, readScore,
  // 出题
  keypoints, getExam, answerAll, getExamResult, runPractice, practiceLoop,
  // 提交
  submitExam,
  // 刷分
  attend, pumpScore, explainLimits, practiceLoop,
  MATCH_COOLDOWN_MS,
  PUMP_RULE_TYPES, PER_ITEM_MAX,
};
