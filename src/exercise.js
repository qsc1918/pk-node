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
 *
 * ★ 2026-10-08：变体**由 version 推导**（不再写死 `'exercise'`）。
 *   服务端按 URL 里的 `version` 选签名算法，写死资产在换版本时会静默错配 → 417。
 *   本函数的 URL 由 `buildPracticeUrl` 组装，公共参数取 `PK.commonQuery.version`，
 *   故显式传它，语义与真机一致。
 */
function maybeSign(path) {
  try {
    return nativeLib.calcSign(path, { version: PK.commonQuery.version });
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
 * 提交整卷成绩：`PUT /leo-math/android/exams/v2/{examId}`（**真机实测路径**）。
 *
 * ## ★ 2026-10-08 修正：提交路径必须带 `/v2/`
 *
 * 真机 App 原生日志（auto_oral-2026-10-01.log，644 条练习流量）实测：
 *
 *     POST /leo-math/android/exams            154 次   ← 出题
 *     PUT  /leo-math/android/exams/v2/{id}      7 次   ← **提交**
 *
 * 旧代码提交到 `/leo-math/android/exams/{id}`（少了 `/v2/`）→ 服务端不认 → **401**。
 *
 * 注意与 PK 的区别：
 *   · PK 提交必须 密文 + octet-stream
 *   · 练习提交必须 **JSON 明文**（编码纪律相反）
 *
 * 作答填 `userAnswer` / `status`(1对/-1错) / `costTime`（下限 5ms）；
 * `script`（笔迹）服务端会校验——点太少会被判「非真人书写」。
 *
 * @returns {Promise<{status:number, json:object|null, text:string}>}
 */
async function submitExam(jar, examId, exam, opts) {
  // ★ 必须带 `/v2/`：2026-10-08 双路径对照实验（同一份 body、仅路径不同）：
  //     PUT /leo-math/android/exams/{id}      → 401（网关不认这条路）
  //     PUT /leo-math/android/exams/v2/{id}   → 400（路由存在、鉴权通过；400 是 body 内容问题）
  //   真机原生日志里的 7 次提交也**全部**是带 `/v2/` 的那条。
  const path = '/leo-math/android/exams/v2/' + examId;

  // ★ body 必须**编码后发**（与 `attend` 同一纪律）。
  //
  //   真机日志逐字证据（auto_oral-2026-10-01.log 18:14:48）：
  //     [PKT][REQ] PUT /leo-math/android/exams/v2/1555281849442996224?... body=˲��)�k...
  //   body 是二进制密文，**不是**可读 JSON。
  //
  //   原先发明文 JSON → 服务端反序列化失败 → 400 `{"message":"error"}`。
  //   注：开发早期「练习提交发明文」的结论是错的（当时用错了路径，
  //   401 掩盖了 body 问题；换成正确的 /v2/ 路径后 400 才暴露出来）。
  //
  //   编码链路与 attend 完全一致：JSON → gzip(仿设备) → keystream XOR。
  let cipher;
  try {
    cipher = nativeLib.encodeSubmitBody(Buffer.from(JSON.stringify(exam), 'utf8'));
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
 * @param {number} [topCostTimeMs] 顶层 `costTime`；不给则 = 每题 × 题数
 *
 * ## ★ 为什么要能分开给（2026-10-08）
 *
 * 实测（tools/probe-top-vs-perq.js，题数 50）：
 *
 *   | 组 | 实际间隔 | 每题 Σ | 顶层 | 结果 |
 *   |----|---------|--------|------|------|
 *   | A  | 12.0s   | 25.0s  | 25.0s | ❌ 400 |
 *   | B  | 13.5s   | 25.0s  | **11.0s** | ✅ **200** |
 *   | C  | 15.0s   | 10.0s  | 11.0s | ✅ 200 |
 *
 * ⇒ 服务端只校验**顶层** `costTime ≤ 实际间隔`，不看每题之和。
 *
 * 于是「上榜速度」（每题 0.5s/题）与「等待时长」（按顶层算）可以解耦：
 *   每题声明 500ms（上榜），顶层声明 200×题数（只等 40s 而非 100s）。
 */
function answerAll(exam, costTimePerQuestionMs, topCostTimeMs) {
  const per = Math.max(5, Number(costTimePerQuestionMs) || 900);
  const questions = (exam.questions || []).map((q, idx) => {
    const answer = q.answer == null ? '' : String(q.answer);
    // 每题用不同 seed，避免笔迹完全雷同（服务端会比对）
    const pathPoints = strokes.buildPathPoints(answer, idx + 1, 'ARC').strokes;
    /**
     * ★ 2026-10-08 修正：字段必须与真机 `QuestionVO` 完全一致。
     *
     * 真机出题响应里每题的真实字段（App 原生日志逐字）：
     *   id / content / answer / userAnswer / answers / script
     *   / wrongScript / status / errorState / costTime
     *
     * 旧代码多塞了一个 `curTrueAnswer` —— 那是项目自造的字段，
     * 真机 QuestionVO **没有它**（真机日志报过
     *   `curTrueAnswer fallback failed: curTrueAnswer in class QuestionVO`），
     * 字段对不上会让服务端反序列化失败 → 400 `{"status":400,"message":"error"}`。
     *
     * 现在只回传真机有的字段，其余保持出题时的原值。
     */
    return {
      id: q.id,
      content: q.content,
      answer: q.answer,
      userAnswer: answer,
      answers: q.answers || [answer],
      script: JSON.stringify(pathPoints),        // 笔迹（服务端据此判卷）
      wrongScript: q.wrongScript == null ? null : q.wrongScript,
      status: 1,                                 // 1 = 答对
      errorState: 0,
      costTime: per,
    };
  });
  const top = Number(topCostTimeMs);
  return Object.assign({}, exam, {
    questions: questions,
    correctCnt: questions.length,
    // 顶层 costTime：可独立于每题之和（见本函数 JSDoc 的说明）。
    // 不给则沿用旧语义（= 每题 × 题数）。
    costTime: Number.isFinite(top) && top >= 0 ? top : per * questions.length,
  });
}

/**
 * 解析本次提交节奏（「上榜模式」）。
 *
 * ## 为什么要可配
 *   实测两个档位：
 *     · 0.2s/题 → 提交通过（日常刷分够用）
 *     · 0.5s/题 → **上榜**需要（结算时间要卡到这个数）
 *
 *   固定的一个值要么慢（拖累日常）、要么上不了榜，所以做成模式。
 *
 * ## 优先级
 *   1. `opts.submitGapPerQMs`  —— 直接给毫秒（最高优先级，供实验/高级用户）
 *   2. `opts.submitPaceMode`   —— `fast`（默认）｜`rank`
 *   3. `PK_EX_SUBMIT_GAP_PER_Q_MS` 环境变量 —— 全局覆盖单题毫秒
 *   4. `PK_EX_SUBMIT_GAP_MODE` 环境变量 —— 全局覆盖模式
 *   5. config.exerciseSubmitPace 的默认值
 *
 * @param {object} [opts] runPractice 的选项
 * @returns {{perQMs:number, padMs:number, label:string, mode:string}}
 */
function resolveSubmitPace(opts) {
  const o = opts || {};
  const cfgPace = (config.exerciseSubmitPace) || {};
  const modes = cfgPace.modes || {};
  const fallbackPad = Math.max(0, Number(cfgPace.fixedPadMs) || 500);

  /**
   * 取一个模式的参数。
   * 兼容两种写法：`{ perQMs, padMs, label }`（新）与纯数字（旧）。
   */
  const pick = (name) => {
    const v = modes[name];
    if (v == null) return null;
    if (typeof v === 'number') {
      return { perQMs: Math.max(0, v), padMs: fallbackPad, label: name, mode: name };
    }
    return {
      perQMs: Math.max(0, Number(v.perQMs) || 0),
      // 顶层系数：决定**等待时长**（服务端只校验顶层 costTime ≤ 实际间隔）
      basePerQMs: v.basePerQMs == null ? null : Math.max(0, Number(v.basePerQMs)),
      padMs: Math.max(0, Number(v.padMs) == null ? fallbackPad : Number(v.padMs)),
      label: v.label || name,
      mode: name,
    };
  };

  // 1) 显式毫秒（优先级最高，供实验/高级用户）
  const explicit = Number(o.submitGapPerQMs);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return {
      perQMs: explicit,
      padMs: Math.max(0, Number(o.submitPadMs) || fallbackPad),
      label: '自定义（' + explicit + 'ms/题）',
      mode: 'custom',
    };
  }
  // 2) 环境变量毫秒
  const envMs = Number(process.env.PK_EX_SUBMIT_GAP_PER_Q_MS);
  if (Number.isFinite(envMs) && envMs >= 0) {
    return {
      perQMs: envMs,
      padMs: Math.max(0, Number(o.submitPadMs) || fallbackPad),
      label: 'env（' + envMs + 'ms/题）',
      mode: 'custom',
    };
  }
  // 3) 模式名（任务配置 / 环境变量 / 默认）
  const name = String(
    o.submitPaceMode || process.env.PK_EX_SUBMIT_GAP_MODE || cfgPace.defaultMode || 'rank',
  ).toLowerCase();
  const got = pick(name);
  if (got) {
    if (o.submitPadMs != null) got.padMs = Math.max(0, Number(o.submitPadMs) || 0);
    return got;
  }
  // 4) 兜底：按用户「主打上榜」的意图走 rank，取不到再 speed
  return pick('rank') || pick('speed')
    || { perQMs: 500, padMs: fallbackPad, label: '上榜模式(兜底)', mode: 'rank' };
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
/**
 * 撞 429 时的重试轮询间隔。
 *
 * ★ 2026-10-08 提速：旧值写死 10s，而出题冷却实测约 58s、
 *   `MATCH_COOLDOWN_MS` 只有 1.5s —— 三者不协调，每轮平均白等 4~5s。
 *   改为可配（默认 3s），把「多等的部分」压到最小。
 */
const MATCH_RETRY_INTERVAL_MS = Math.max(
  500,
  Number((config.exerciseSpeed && config.exerciseSpeed.matchRetryMs) || process.env.PK_EX_MATCH_RETRY_MS) || 3_000,
);
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
    // ★★ 2026-10-08 修正：`idString === "0"` 是**空卷**（账号级软限），
    //   不是成功。旧判断 `g.json.idString` 会把字符串 "0" 当成真值 →
    //   空卷被误判为出题成功 → 后面整卷作答 + 提交全部白做。
    //
    //   实测（tools/diagnose-empty-exam.js，11 账号 × 2 知识点）：
    //     能出真卷: id=5, 18, 32, 35, 36
    //     永远空卷: id=2, 7, 17, 27, 28（等 20s 也没用，与知识点无关）
    //   ⇒ 空卷是**账号级**软限，只能换账号，重试无益。
    const emptyExam = (j) => !j || j.idString == null || String(j.idString) === '0';
    if (g.status === 200 && g.json && !emptyExam(g.json)) break;
    if (g.status === 200 && emptyExam(g.json)) {
      // 200 但是空卷：不是频控，重试也没用 —— 直接如实上报，让上层换账号。
      emit({
        type: 'ex-fail',
        message: `出题返回空卷（idString=0）—— 该账号已被服务端软限（额度用尽或受限），换账号重试`,
      });
      return {
        ok: false, stage: 'match', status: 200, empty: true, text: g.text,
        reason: 'empty-exam',
      };
    }
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
    // ★ 冲榜模式：贴着窗口轮询抢（400ms 一跳），而不是提前等够。
    //   依据 tools/recheck-cooldown.js：冷却是每账号独立的硬约束，
    //   抢比等更快也更准（少等一个周期就是纯赚）。
    const retryMs = (function () {
      try {
        const p = resolveSubmitPace(o);
        if (p && p.mode === 'rush') {
          const r = Number((config.exerciseSpeed || {}).rushRetryMs);
          if (Number.isFinite(r) && r > 0) return r;
        }
      } catch (e) { /* ignore */ }
      return MATCH_RETRY_INTERVAL_MS;
    })();
    emit({
      type: 'ex-rate-limit',
      message: `出题被限流（HTTP 429），${(retryMs / 1000).toFixed(1)}s 后重试（已等 ${Math.round(waited / 1000)}s）`,
    });
    await sleep(retryMs, o.signal);
    live();
  }

  const exam = g.json;
  /** 出题**成功**的时刻（提交节奏校验的基准，见下方「防机器秒答」注释）。 */
  const matchOkAt = Date.now();
  emit({
    type: 'ex-match-ok',
    message: `出题成功 examId=${exam.idString} ${exam.keypoint} 共 ${exam.questionCnt} 题（预计 +${exam.questionCnt * 2} 经验）`,
  });

  // 2) 作答（抄答案 + 生成笔迹 —— 服务端靠笔迹判卷）
  //
  // ★★ 2026-10-08 定标：等待量 = 题数 × **单题间隔**，**与声明耗时无关**。
  //
  // 服务端校验「提交时刻 − 出题时刻」的**实际间隔**，按题数放大；
  // 与请求里声明的 `costTime` 完全无关（见 config.js 的说明与
  // tools/probe-declared-vs-elapsed.js：声明 1ms 也照样过）。
  //
  // 两个实测系数（用户提供 / 我的梯度互相印证）：
  //   · **0.2s/题** → 提交即可通过（`fast`，默认）
  //   · **0.5s/题** → **上榜**所需，结算时间要卡到这个数（`rank`）
  //
  // ⚠️ 我曾误把等待写成「= 声明总耗时（900ms/题）」，100 题干等 90s。
  //    那不是服务端要求，是误判。现在按模式取系数，可随任务配置。
  //
  // ⚠️ 另注：本轮的 400 常见**不是**节奏问题，而是 **script（笔迹）
  //    坐标不合格** —— 见 tools/isolate-400.js：
  //       script=null → 200 ｜ script=<我们生成的笔迹> → 400
  //    所以这里的等待即使给足了，笔迹不合格照样 400。
  const pace = resolveSubmitPace(o);
  const gapPerQ = pace.perQMs;
  const gapBase = pace.padMs;
  const qNum = (exam.questions || []).length || 1;
  /**
   * ★★ 2026-10-08 关键解耦：**等待只按「顶层 costTime」算，不按每题之和**。
   *
   * ## 决定性实验（tools/probe-top-vs-perq.js，题数 50）
   *
   *   | 组 | 实际间隔 | 每题 Σ | 顶层 costTime | 结果 |
   *   |----|---------|--------|--------------|------|
   *   | A  | 12.0s   | 25.0s  | 25.0s        | ❌ 400 |
   *   | B  | 13.5s   | 25.0s  | **11.0s**    | ✅ **200** |
   *   | C  | 15.0s   | 10.0s  | 11.0s        | ✅ 200 |
   *
   *   ⇒ 服务端只校验 **顶层 costTime ≤ 实际间隔**，
   *     **不校验**「每题 costTime 之和」。
   *
   * ## 于是可以两全
   *
   *   用户给的两个实测系数：
   *     · 0.2s/题 → 够过提交
   *     · 0.5s/题 → 上榜（结算时间卡到这里）
   *
   *   上榜要求的是**每题声明的速度**；而等待只受**顶层**约束。
   *   所以：
   *     · 每题声明 `pace.perQMs`（rank=500ms → 上榜速度）
   *     · 顶层声明 `submitBasePerQMs`（=200ms → 只等这么多）
   *
   *   ⇒ 200 题的等待从 **100.5s 降到 40.5s**，上榜资格不变。
   *
   * ## 另一条已确认的约束（tools/probe-rank-vs-wait.js）
   *
   *   实际间隔必须 ≥ 顶层 costTime，否则 400：
   *     A 间隔 10.2s / 顶层 10.0s → 200
   *     B 间隔 11.3s / 顶层 25.0s → ❌ 400
   *     C 间隔 27.0s / 顶层 25.0s → 200
   *
   *   （我此前记的「服务端不看声明值」是**误读** —— 那组恰巧实际间隔也够。）
   */
  // 顶层系数优先级：模式自带 > 环境变量 > 默认 200
  // （冲榜模式自带 200ms/题；rank/speed 也各自给了 basePerQMs）
  const basePerQ = Math.max(0,
    (pace.basePerQMs == null ? Number(process.env.PK_EX_SUBMIT_BASE_PER_Q_MS) : pace.basePerQMs)
    || 200);
  const minGapMs = gapBase + qNum * basePerQ;

  // 基准必须用**出题成功**时刻（matchOkAt），不能用 tMatch：
  // tMatch 是出题**开始**时刻，若中间被 429 限流重试过，会把重试等待
  // 也算进 elapsed → 高估已过时间 → 等待不足。
  const elapsedMs = Date.now() - matchOkAt;
  const waitMs = minGapMs - elapsedMs;
  if (waitMs > 0) {
    emit({
      type: 'ex-pace',
      message: `等待 ${(waitMs / 1000).toFixed(1)}s 后提交（${pace.label} ${gapPerQ}ms/题 × ${qNum} 题，需 ≥ ${(minGapMs / 1000).toFixed(1)}s，已过 ${(elapsedMs / 1000).toFixed(1)}s）`,
    });
    await sleep(waitMs, o.signal);
    live();
  }

  // 每题声明耗时：优先用调用方给的，否则用**模式值**（rank=500ms → 上榜速度）。
  // ★ 顶层 costTime 单独给 `basePerQ × 题数`（默认 200ms/题）。
  //   依据：服务端只校验顶层 ≤ 实际间隔，不看每题之和
  //   （tools/probe-top-vs-perq.js）。这样「上榜速度」与「等待时长」解耦：
  //     每题 500ms（上榜）＋ 顶层 200ms×题数（只等 40s，而非 100s）。
  //
  // ⚠️ 每题值**不能**再被「实际间隔」压小：
  //   旧代码写过 `Math.min(declaredHint, gapMs/qNum)`，那会把 500ms 压成
  //   实际能给出的值（如 200ms），上榜速度就丢了。按上面的结论，
  //   服务端不看每题之和，所以直接用模式值即可。
  const perQ = Math.max(5, Number(o.costTimePerQuestionMs) || gapPerQ);
  const topCost = Math.max(5, Number(o.topCostTimeMs) || basePerQ * qNum);
  const answered = answerAll(exam, perQ, topCost);

  live();
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
   *
   * ★ 2026-10-08 修正：
   *   ① **第一轮不等**。开跑前那一次等待毫无意义（前面根本没有请求，
   *      不存在「距上次出题多久」的问题）。旧代码用它来「避开频控窗口」，
   *      但那只在**连续轮次**之间才有意义。现在第一轮直接发车。
   *   ② **出题等待可自定义**：`o.matchWaitMinMs` / `o.matchWaitMaxMs`
   *      给「每轮间隔」一套独立的取值范围（不填则仍用 gapMin/gapMax）。
   *      命名为「出题等待」是因为它等的是下一轮**出题**的时机。
   */
  const gapMin = Math.max(0, Number(o.gapMinMs) || 0);
  const gapMax = Math.max(gapMin, Number(o.gapMaxMs) || 0);
  // 出题等待（可独立配置；缺省沿用 gapMin/gapMax，保持旧行为）
  const mwMinRaw = o.matchWaitMinMs == null ? null : Number(o.matchWaitMinMs);
  const mwMaxRaw = o.matchWaitMaxMs == null ? null : Number(o.matchWaitMaxMs);
  const mwMin = Math.max(0, mwMinRaw == null ? gapMin : mwMinRaw);
  const mwMax = Math.max(mwMin, mwMaxRaw == null ? gapMax : mwMaxRaw);
  // 安全边距：从冷却下沿往回退一点，避免贴着窗口边缘白撞 429（默认 200ms）。
  const safety = o.cooldownSafetyMs == null ? 200 : Math.max(0, Number(o.cooldownSafetyMs));
  const randGap = () => (gapMax > gapMin
    ? gapMin + Math.floor(Math.random() * (gapMax - gapMin + 1))
    : gapMin);
  const randMatchWait = () => (mwMax > mwMin
    ? mwMin + Math.floor(Math.random() * (mwMax - mwMin + 1))
    : mwMin);

  let lastMatchOkAt = 0;
  let done = 0, failed = 0, totalExp = 0;
  let lastWaitMs = 0;

  for (let i = 1; i <= rounds; i++) {
    if (o.signal && o.signal.aborted) throw abortedError();

    // 每轮间隔：冷却剩余 与 随机间隔 取大者。
    // ★ 第一轮跳过（lastMatchOkAt=0）—— 开跑前无需等。
    if (lastMatchOkAt) {
      const cooldownLeft = Math.max(0, lastMatchOkAt + MATCH_COOLDOWN_MS - safety - Date.now());
      const gap = randMatchWait();
      const wait = Math.max(cooldownLeft, gap);
      lastWaitMs = wait;
      if (wait > 0) {
        emit({
          type: 'ex-gap',
          round: i,
          message: `出题等待 ${(wait / 1000).toFixed(1)}s 后开始第 ${i} 轮` +
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
  resolveSubmitPace,
  MATCH_COOLDOWN_MS,
  MATCH_RETRY_INTERVAL_MS,
  PUMP_RULE_TYPES, PER_ITEM_MAX,
};
