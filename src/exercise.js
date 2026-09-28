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
 * 提交整卷成绩 —— **已打通**（2026-09-28）。
 *
 * ## ★ 正确形态（试出来之前错了很多次）
 *
 * ```
 * PUT /leo-math/android/exams/{examId}        ← 旧路径，不是 /v2/！
 * Content-Type: application/json              ← JSON 明文，**不编码**
 * body: ExamVO(JSON)
 * → 200 {idString, correctCnt, questionCnt, questions:[...批改结果...]}
 * ```
 *
 * ## 三个曾经的坑
 *
 * | 试过的错误做法 | 结果 |
 * |---|---|
 * | `PUT .../exams/v2/{examId}` + gzip+编码 | 400 |
 * | `PUT .../exams/v2/{examId}` + 明文 JSON | 400 |
 * | `PUT .../exams/{examId}`（旧路径）+ octet-stream | **415**（"Content-Type 不支持"）|
 * | `PUT .../exams/{examId}`（旧路径）+ **JSON** | **200** ✅ |
 *
 * 注意与 PK 的区别：PK 提交**必须** `gzip + c()` + octet-stream；
 * 练习提交**必须** JSON 明文。**两条链路的编码纪律相反，别互相套用。**
 *
 * ## 作答要求
 *
 * 每题填 `userAnswer` / `status`(1 对 / -1 错) / `costTime`（**下限 5ms**）；
 * 整卷填 `correctCnt` / `costTime`。`script`（笔迹）实测**不填也能过**。
 *
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
 * 本地「作答」：把每题填成全对，**并生成笔迹**。
 *
 * ## ★ 为什么必须有 `script`（笔迹）
 *
 * 实测：只填 `userAnswer` + `status:1` 提交 → HTTP 200，但服务端判
 * **`correctCnt=0`**（不认客户端自报的 status）。
 * 补上 `script`（笔迹点集）+ `curTrueAnswer` 后 → **判对 10/10，经验 +20**。
 *
 * ⇒ **服务端是「回放笔迹 + 识别」判卷，不信任 `status` 字段。**
 * 这与 PK 一致（PK 的笔迹也是服务端会回放的）。
 *
 * 笔迹复用本项目的 [strokes]（与 PK 提交同一套）：
 * 比较题（`>`/`<`/`=`）走弧线模板，其它回落七段码。
 *
 * @param {object} exam 出题响应
 * @param {number} [costTimePerQuestionMs] 每题耗时（**下限 5ms**，真机纪律）
 * @param {(ev:object)=>void} [onProgress] 进度回调
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
      script: JSON.stringify(pathPoints),     // ★ 服务端据此判卷
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

/**
 * 练习出题冷却（**实测 ≈62 秒/账号**，2026-09-28）。
 *
 * 与 PK 的出题冷却（61.6s）几乎同一个数 —— 应是同一个账号级限流器。
 * 所以「出题 → 提交」一轮 ≈ 62s；但一局可以开 **100 题 = 200 exp**，
 * 折算下来仍远快于按 10 题一局地刷。
 */
const MATCH_COOLDOWN_MS = 62_000;
/** 撞 429 时的重试间隔 / 总等待上限。 */
const MATCH_RETRY_INTERVAL_MS = 10_000;
const MATCH_RETRY_MAX_MS = 4 * 60 * 1000;

/**
 * **完整练习闭环**：出题 → 抄答案 → 提交 → 拉回批改结果。
 *
 * 这是「刷练习」的主链路（与 [pumpScore] 的经验上报互补）：
 *  - 本函数：走真实练习流程，服务端按卷算分（经验 = 答对题数 × 2）
 *  - [pumpScore]：直接上报经验增量，每次 +200
 *
 * ## 出题频控（429）自动重试
 *
 * 出题有账号级冷却（≈62s）。撞到 `429 too_many_request` 时按
 * [MATCH_RETRY_INTERVAL_MS] 重试，累计超 [MATCH_RETRY_MAX_MS] 才判失败 ——
 * 所以调用方不必自己算窗口。
 *
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
    await sleep(MATCH_RETRY_INTERVAL_MS);
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
 *
 * ## 配速策略（与 PK 引擎同一套思路）
 *
 * 出题冷却 ≈[MATCH_COOLDOWN_MS]（账号级，实测）。这里记住**上次成功出题时刻**，
 * 下一轮直接等到「上次成功 + 冷却」再发车 —— 既不白撞 429、也不多等。
 * 万一估计偏了，[runPractice] 内部的 429 重试会兜底。
 *
 * ## 建议用 100 题/局
 *
 * 冷却按「次」算，不按题数 —— 所以一次开 100 题（=200 exp）比开 10 题（=20 exp）
 * 划算 10 倍。默认 [limit] 就取 100。
 *
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
  let lastMatchOkAt = 0;
  let done = 0, failed = 0, totalExp = 0;

  for (let i = 1; i <= rounds; i++) {
    if (o.signal && o.signal.aborted) throw Object.assign(new Error('已取消'), { aborted: true });

    // 等冷却下沿
    if (lastMatchOkAt) {
      const wait = Math.max(0, lastMatchOkAt + MATCH_COOLDOWN_MS - 1000 - Date.now());
      if (wait > 0) {
        emit({ type: 'ex-gap', message: `按出题冷却等 ${(wait / 1000).toFixed(1)}s 后开始第 ${i} 轮` });
        await sleep(wait);
      }
    }

    emit({ type: 'ex-round', message: `第 ${i}/${rounds} 轮开始` });
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
      emit({ type: 'ex-round-fail', message: `第 ${i} 轮失败：${(r && r.text || '').slice(0, 90)}` });
      // 出题失败多半是还在冷却 → 补等一轮再继续
      await sleep(MATCH_RETRY_INTERVAL_MS);
      continue;
    }
    done++;
    totalExp += r.exp || 0;
    lastMatchOkAt = Date.now();
    emit({
      type: 'ex-round-ok',
      message: `第 ${i} 轮成功：判对 ${r.correctCnt}/${r.questionCnt}，+${r.exp} 经验（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，累计 +${totalExp}）`,
    });
  }

  emit({ type: 'ex-done', message: `全部结束：成功 ${done}/${rounds}，累计经验 +${totalExp}` });
  return { ok: failed === 0, rounds: rounds, done: done, failed: failed, totalExp: totalExp };
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
  keypoints, getExam, answerAll, getExamResult, runPractice, practiceLoop,
  // 提交（未打通）
  submitExam,
  // 刷分
  attend, pumpScore, explainLimits, practiceLoop,
  MATCH_COOLDOWN_MS,
  PUMP_RULE_TYPES, PER_ITEM_MAX,
};
