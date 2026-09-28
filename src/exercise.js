'use strict';
/**
 * 练习（`/leo-star` `/leo-math`）协议层。
 *
 * ## 与 PK 的关系
 *
 * 练习与 PK 是**两条独立链路**，别混：
 *
 * | | PK（`leo-game-pk`） | 练习（`leo-star` / `leo-math`） |
 * |---|---|---|
 * | `version` | 3.141.1（沿用 PK.commonQuery） | **3.140.1（必须！否则 417）** |
 * | `platform` | android36 | **android37** |
 * | `sign` | 不需要 | 也不需要（实测） |
 * | 频控 | 出题 ~61.6s/账号 | 见 [explainLimits] |
 *
 * ## 417 墙的根因（2026-09-28 实测）
 *
 * 主域端点被 `solar-encoder` 拦成 `417 No message available`，
 * 根因**只有一个**：`version` 用了 3.141.1。改 3.140.1 立刻 200。
 * 逐项 A/B 见 `config.exercise` 的注释。
 *
 * ## 三条可用链路
 *
 * 1. **出题**：`POST /leo-math/android/exams`（form: keypointId + limit）
 *    → 返回 `{idString, questions[{content, answer, ...}]}`
 *    —— 每题都带 `answer`，所以「作答」= 抄答案。
 * 2. **整卷提交**：`PUT /leo-math/android/exams/v2/{examId}`（`@NeedEncode`）
 *    —— ⚠️ 尚未打通（见 [submitExam] 注释）。
 * 3. **经验上报**：`POST /leo-star/android/exercise/rank/login/attend`（`@NeedEncode`）
 *    —— ✅ 已验证能记账，每次 +200。
 */

const { config, PK } = require('./config');
const { request } = require('./http');
const nativeLib = require('./native');

/** 练习专用公共参数（在 PK 里，见 config.js 的 PK.exercise）。 */
const EX = PK.exercise;
const keystream = require('./keystream');

/* ------------------------------------------------------------------ 工具 */

/** 20 位 [a-z0-9] traceId（原版形态）。 */
function randomTraceId() {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 20; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

/**
 * 练习专用请求头（对齐原版抓包逐字）。
 *
 * 与 PK 的 [leo.riskHeaders] 区别：这里必须带 `leo-client-trace-id` 与
 * `default-namespace-sw8` —— 主域风控会看它们。
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
  // ⚠️ UA 里的 Android 版本是 **17**（原版抓包逐字），不是 SDK 号 37。
  // 这两处不一样：query 的 `platform=android37` 用 SDK 号，
  // 而 UA 用「Android 17」。用 37 会被风控识别成异构请求（实测 417）。
  return 'Leo/' + EX.version +
    ' (' + d.brand + d.model + '; Android ' + (d.uaSdk || 17) + '; Scale/' + d.scale + ')';
}

/**
 * 拼练习 URL。
 *
 * 严格按原版顺序：`_productId` 最前、`sign` 最后（参数顺序原版确实如此，
 * 虽然服务端大概率不校验，但既然要「逐字对齐」就做全）。
 * sign 由原生库算（纯 JS 不可复现），算不出来就不带 —— 练习实测不需要它。
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
 * 练习端点的签名策略。
 *
 * ## ★ 练习**必须**带 sign（2026-09-28 实测）
 *
 * ```
 * 不带 sign → 417 No message available   （solar-encoder 拦）
 * 带 sign   → 200
 * ```
 *
 * 与 PK 相反（PK 的 home/match/submit 都不需要 sign）。
 * 所以这里**不受 `config.signMode` 影响**：只要原生库在，就一定算上；
 * 只有确实算不出来时才退化为不带（并会在 selftest 里体现）。
 *
 * 这也解释了「PK 能在 Windows 上跑、练习不能」：练习依赖 sign（arm64 原生库）。
 */
function maybeSign(path) {
  try {
    return nativeLib.calcSign(path);
  } catch (e) {
    // 算不出来（如 x86 无原生库）→ 不带。此时练习端点会 417，
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
 *
 * ⚠️ `book` / `grade` / `semester` **三个都必填**（缺哪个服务端就报哪个）。
 * 默认值取本机实测可用组合：`book=54, grade=1, semester=1`。
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
 * `POST /leo-math/android/exams` —— **出一整套题**。
 *
 * body 是 form-urlencoded 的 `keypointId` + `limit`（原版 `@Field` 都是 String）。
 *
 * 返回的 `questions[]` **每题自带 `answer`** —— 所以「作答」就是抄答案，
 * 不需要解题模型。这正是本项目能把练习做成流水线的原因。
 *
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
 * `PUT /leo-math/android/exams/v2/{examId}` —— 整卷提交（`@NeedEncode`）。
 *
 * ## ⚠️ 尚未打通（如实记录）
 *
 * 已穷举测试，**全部 400 `{"status":400,"message":"error"}`**：
 *
 * | 传输形态 | 结果 |
 * |---|---|
 * | 明文 JSON + `application/json` | 400 |
 * | 仅 gzip + octet-stream | 400 |
 * | 仅 `c()` + octet-stream | 400 |
 * | `gzip + c()` + octet-stream | 400 |
 * | 明文 + octet-stream | 400 |
 *
 * × body 变体（完整 exam / 精简 / 带 Int id / 去掉 idString）也一样。
 *
 * ⇒ **编码不是原因**（同一套编码在 `attend` 上能 200），是 **body 校验**。
 * 下一步需要一次**真机练习提交抓包**来做逐字段对比。
 *
 * 注意：这不是 417（认证/风控层已过），是业务层的 400。
 */
async function submitExam(jar, examId, exam, opts) {
  const path = '/leo-math/android/exams/v2/' + examId;
  const plain = Buffer.from(JSON.stringify(exam), 'utf8');
  let cipher;
  try {
    cipher = nativeLib.encodeSubmitBody(plain);
  } catch (e) {
    return { status: null, text: '编码失败：' + e.message, error: true };
  }
  const r = await request({
    url: buildExerciseUrl(path),
    method: 'PUT',
    jar,
    body: cipher,
    signal: opts && opts.signal,
    headers: exerciseHeaders({ 'Content-Type': 'application/octet-stream' }),
  });
  return { status: r.status, json: safeJson(r.text), text: r.text, sentBytes: cipher.length };
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
 * 本地「作答」：把每题填成全对。
 *
 * `status: 1` = 答对（`ExamQuestion.STATUS_RIGHT`）；
 * `costTime` 给个非零值（服务端对 0ms 敏感，与 PK 同理）。
 */
function answerAll(exam, costTimePerQuestionMs) {
  const per = Math.max(1, Number(costTimePerQuestionMs) || 900);
  const questions = (exam.questions || []).map((q) => Object.assign({}, q, {
    userAnswer: q.answer,
    status: 1,
    costTime: per,
  }));
  return Object.assign({}, exam, {
    questions: questions,
    correctCnt: questions.length,
    costTime: per * questions.length,
  });
}

/* ---------------------------------------------------- 经验上报（刷分） */

/**
 * 可记账的 `ruleType`（**实测**，2026-09-28）。
 *
 * 全量枚举 0~43 后，只有 **0 和 1** 会让 `curWeekScore` 真正增加；
 * 其余（2..16, 20, 33, 41, 43）服务端都返回 200 但不记账。
 */
const PUMP_RULE_TYPES = [0, 1];

/** 单条 `obtainExp` 的服务端 clamp 上限（发更多也只记这么多）。 */
const PER_ITEM_MAX = 200;

/**
 * `POST /leo-star/android/exercise/rank/login/attend` —— **经验上报（刷分）**。
 *
 * ## 语义
 *
 * body 是**增量**上报：`obtainExp` = 本次获得经验，服务端累加到周分数。
 * 不是「设置总分」。所以这是唯一能直接加分的合法链路。
 *
 * ## 编码
 *
 * 带 `@NeedEncode`：**必须** `gzip + c()` 且 `Content-Type: octet-stream`。
 * 明文直接发 → **HTTP 500**；编码后 → **200 `{data:true}`**。
 *
 * ## 频率（实测，重要）
 *
 * **每个可记账 `ruleType` 每天只记一次。** 同一 ruleType 第二次发会返回
 * `{data:true}` 但分数不动 —— 服务端静默丢弃，不报错。
 * 所以日上限 = `200 × |PUMP_RULE_TYPES|` = **400**。
 *
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
 * 「刷分」：对每个可记账 ruleType 各上报一次，**以服务端入账为准**返回。
 *
 * 为什么按 ruleType 遍历而不是「拆条」：`obtainExp` 的语义是
 * 「本次练习获得的经验」，同一天同一 ruleType 发多条属于伪造行为且**并不加分**
 * （服务端按 ruleType/天去重）。不同 ruleType 各记一笔才是原版语义。
 *
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

/** 小睡（内部用）。 */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  // 头 / URL
  exerciseHeaders, buildExerciseUrl, exerciseUa, randomTraceId,
  // 读
  homepage, rankPrefetch, itemStatus, taskHome, overview, readScore,
  // 出题
  keypoints, getExam, answerAll, getExamResult,
  // 提交（未打通）
  submitExam,
  // 刷分
  attend, pumpScore, explainLimits,
  PUMP_RULE_TYPES, PER_ITEM_MAX,
};
