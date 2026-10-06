'use strict';
/**
 * ============================================================================
 *  pk-h5 私服 —— 自己的题库 / 判分 / 对局 / 榜单，不代理小猿真实接口
 * ============================================================================
 *
 * ## 这是什么
 *
 * 给小猿口算 PK 那套 H5（`leo-web-oral-pk`）写一个**我们自己的服务端**。
 * H5 页面对它发请求，拿到的所有数据都由本模块生成 ——
 * 出题是我们出的、判分是我们判的、榜单是我们排的。
 *
 * 与 `pk-h5-proxy.js` 的区别（别混）：
 *   · `pk-h5-proxy.js` = **代理**：把 H5 的请求转发到小猿真实服务器，用真账号的 cookie。
 *   · `pk-h5-localserver.js`（本文件）= **私服**：请求就地处理，不碰小猿服务器。
 *
 * ## 为什么必须自己加密
 *
 * H5 用 `responseType:'arraybuffer'` 拉 `match/v2`，拿到密文后调桥
 * `LeoSecure.dataDecrypt` 解密；提交时调 `dataEncrypt` 加密。
 * 所以私服必须：
 *   出：明文 → gzip(设备口径) → keystream XOR → 密文 arraybuffer
 *   入：密文 → keystream XOR → gunzip → 明文
 * 这两条链路在 `src/native.js` / `src/keystream.js` 里已有且已验证。
 *
 * ## H5 依赖的接口（从 bundle 里逐行读出来的，不是猜的）
 *
 * | 方法 | 路径 | 响应 |
 * |---|---|---|
 * | GET  | `/leo-game-pk/{client}/math/pk/home?grade=N` | 明文 JSON（首页卡片） |
 * | POST | `/leo-game-pk/{client}/math/pk/match/v2?pointId=X&triggerPeakMatch=0` | **密文**（题卷） |
 * | PUT  | `/leo-game-pk/{client}/math/pk/submit` | body 是**密文**，响应明文 |
 * | GET  | `/leo-game-pk/{client}/math/pk/history/detail?pkIdStr=X` | 明文 JSON（结算页） |
 * | GET  | `/leo-game-pk/{client}/game/rank?...` | 明文 JSON（榜单） |
 *
 * `{client}` 由 H5 的 `requestConfig` 桥换成 `api`（见 pk-h5-proxy 的桥）。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const keystream = require('./keystream');
const native = require('./native');
const { config } = require('./config');

/* ------------------------------------------------------------------ 存储 */

const DIR = path.join(config.root, 'data', 'pk-h5-localserver');
const DB_FILE = path.join(DIR, 'pk-h5-localserver.json');

/**
 * 私服自己的轻量存储。刻意不用 SQLite：
 * 数据量小（题库 + 对局记录），JSON 足够，且方便用户直接看/改。
 * 写入用「临时文件 + rename」保证原子性。
 */
const DEFAULT_STATE = {
  version: 1,
  /** 自增：对局序号（拼 pkIdStr 用） */
  seq: 1000,
  /** 对局记录：pkIdStr -> record */
  matches: {},
  /** 题库覆盖：pointId -> 题目数组（有就用，没有就按题型现生成） */
  banks: {},
  /** 榜单：grade -> [{userId,name,score,avatarUrl}] */
  ranks: {},
  /** 统计 */
  stats: { totalMatches: 0, totalQuestions: 0 },
};

let state = null;

function load() {
  if (state) return state;
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    state = Object.assign({}, DEFAULT_STATE, JSON.parse(raw));
    // 补齐新增字段（老文件可能缺）
    state.stats = Object.assign({}, DEFAULT_STATE.stats, state.stats || {});
    state.matches = state.matches || {};
    state.banks = state.banks || {};
    state.ranks = state.ranks || {};
  } catch (e) {
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  return state;
}

function save() {
  const s = load();
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('[pk-h5-localserver] 保存失败：' + e.message);
  }
}

/* ------------------------------------------------------------------ 出题 */

/**
 * 题型定义。`pointId` 对齐真实小猿的知识点 ID（2035/2036/... 那些），
 * 这样 H5 首页/竞速页传进来的 pointId 能直接用。
 *
 * 每道题产出：
 *   { questionId, content, answer, script, pointId, ruleType }
 *   · `content`  显示在题目区（纯文本算式）
 *   · `answer`   正确答案（判分基准，**只在服务端**用）
 *   · `script`   笔迹点集 JSON（H5 的答题板会画出来）
 */
const TOPICS = [
  {
    pointId: 1,
    name: '一二年级·加减法',
    ruleType: 1,
    make: () => {
      const a = 1 + Math.floor(Math.random() * 20);
      const b = 1 + Math.floor(Math.random() * 20);
      return { content: `${a}+${b}=`, answer: String(a + b) };
    },
  },
  {
    pointId: 2,
    name: '一二年级·减法',
    ruleType: 1,
    make: () => {
      const a = 10 + Math.floor(Math.random() * 30);
      const b = 1 + Math.floor(Math.random() * a);
      return { content: `${a}-${b}=`, answer: String(a - b) };
    },
  },
  {
    pointId: 3,
    name: '三年级·乘法口诀',
    ruleType: 1,
    make: () => {
      const a = 2 + Math.floor(Math.random() * 8);
      const b = 2 + Math.floor(Math.random() * 8);
      return { content: `${a}×${b}=`, answer: String(a * b) };
    },
  },
  {
    pointId: 4,
    name: '三四年级·除法',
    ruleType: 1,
    make: () => {
      const b = 2 + Math.floor(Math.random() * 8);
      const q = 2 + Math.floor(Math.random() * 8);
      return { content: `${b * q}÷${b}=`, answer: String(q) };
    },
  },
  {
    pointId: 2035,
    name: '20以内加减法',
    ruleType: 1,
    make: () => {
      if (Math.random() < 0.5) {
        const a = 1 + Math.floor(Math.random() * 10);
        const b = 1 + Math.floor(Math.random() * (20 - a));
        return { content: `${a}+${b}=`, answer: String(a + b) };
      }
      const a = 5 + Math.floor(Math.random() * 15);
      const b = 1 + Math.floor(Math.random() * a);
      return { content: `${a}-${b}=`, answer: String(a - b) };
    },
  },
  {
    pointId: 2036,
    name: '100以内加减法',
    ruleType: 1,
    make: () => {
      if (Math.random() < 0.5) {
        const a = 10 + Math.floor(Math.random() * 60);
        const b = 1 + Math.floor(Math.random() * (100 - a));
        return { content: `${a}+${b}=`, answer: String(a + b) };
      }
      const a = 20 + Math.floor(Math.random() * 80);
      const b = 1 + Math.floor(Math.random() * a);
      return { content: `${a}-${b}=`, answer: String(a - b) };
    },
  },
  {
    pointId: 99,
    name: '混合运算',
    ruleType: 1,
    make: () => {
      const kind = Math.floor(Math.random() * 3);
      if (kind === 0) {
        const a = 2 + Math.floor(Math.random() * 9);
        const b = 2 + Math.floor(Math.random() * 9);
        const c = 1 + Math.floor(Math.random() * 20);
        return { content: `${a}×${b}+${c}=`, answer: String(a * b + c) };
      }
      if (kind === 1) {
        const a = 2 + Math.floor(Math.random() * 9);
        const b = 2 + Math.floor(Math.random() * 9);
        const c = 1 + Math.floor(Math.random() * 9);
        return { content: `${a}×${b}-${c}=`, answer: String(a * b - c) };
      }
      const a = 10 + Math.floor(Math.random() * 40);
      const b = 2 + Math.floor(Math.random() * 8);
      return { content: `${a}+${b}×2=`, answer: String(a + b * 2) };
    },
  },
];

const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.pointId, t]));

function topicOf(pointId) {
  return TOPIC_BY_ID.get(Number(pointId)) || TOPICS[0];
}

/**
 * 出一份题卷。
 *
 * @param {object} o
 * @param {number} o.pointId
 * @param {number} [o.questionCount] 题数，默认 10
 * @returns {{pkIdStr:string, pointId:number, pointName:string, ruleType:number,
 *            questionCnt:number, questions:Array}}
 */
function makeMatch(o = {}) {
  const s = load();
  const topic = topicOf(o.pointId);
  const count = Math.max(1, Math.min(50, Number(o.questionCount) || 10));

  // 优先用「题库覆盖」（用户在后台塞的题），不够就现场生成补足
  const bank = Array.isArray(s.banks[topic.pointId]) ? s.banks[topic.pointId] : [];
  const questions = [];
  for (let i = 0; i < count; i++) {
    let q;
    if (bank.length) {
      const src = bank[i % bank.length];
      q = { content: src.content, answer: String(src.answer) };
    } else {
      q = topic.make();
    }
    questions.push({
      questionId: i + 1,
      pointId: topic.pointId,
      ruleType: topic.ruleType,
      content: q.content,
      answer: q.answer,
      script: '[]',
    });
  }

  s.seq += 1;
  const pkIdStr = 'PKLOCAL' + s.seq;
  const match = {
    pkIdStr,
    pointId: topic.pointId,
    pointName: topic.name,
    ruleType: topic.ruleType,
    questionCnt: questions.length,
    examVO: {
      pkIdStr,
      pointId: topic.pointId,
      pointName: topic.name,
      ruleType: topic.ruleType,
      questionCnt: questions.length,
      questions,
      costTime: 0,
      correctCnt: 0,
    },
    createdAt: Date.now(),
    /** 服务端留底，用于判分（H5 拿不到 answer —— 它是服务端才该有的） */
    _answers: questions.map((q) => q.answer),
  };

  // 入库：题目入库时**不带** answer 之外的答案口径字段（H5 只要 content/script）
  s.matches[pkIdStr] = {
    pkIdStr,
    pointId: topic.pointId,
    pointName: topic.name,
    questionCnt: questions.length,
    createdAt: match.createdAt,
    submitted: false,
    answers: match._answers,
    questions: questions.map((q) => ({
      questionId: q.questionId,
      content: q.content,
      answer: q.answer,
      script: q.script,
    })),
  };
  s.stats.totalQuestions += questions.length;
  save();
  return match;
}

/* --------------------------------------------------------------- 判分/结算 */

/**
 * 收卷并判分。
 *
 * H5 交上来的 body（明文，经 dataEncrypt 解密后）形如：
 *   { pkIdStr, examVO:{ questions:[{questionId,content,userAnswer,status,script,...}],
 *                       correctCnt, costTime, ... } }
 * 其中 `userAnswer` 是孩子写的手写识别结果，`status` 由 H5 自己填（1=对）；
 * **我们不信 H5 的 status**，按服务端留底的 answer 重新判一遍。
 *
 * @param {object} body 解密后的提交体
 * @returns {{ok:boolean, message?:string, result?:object}}
 */
function gradeSubmit(body) {
  const s = load();
  if (!body || typeof body !== 'object') return { ok: false, message: '提交体不是对象' };
  const pkIdStr = String(body.pkIdStr || (body.examVO && body.examVO.pkIdStr) || '');
  if (!pkIdStr) return { ok: false, message: '提交体缺 pkIdStr' };

  const rec = s.matches[pkIdStr];
  if (!rec) return { ok: false, message: '对局不存在：' + pkIdStr };

  const examVO = body.examVO || {};
  const submitted = Array.isArray(examVO.questions) ? examVO.questions : [];

  // 逐题重判：以服务端留底的答案为准
  let correct = 0;
  const graded = rec.questions.map((q, i) => {
    const sub = submitted[i] || {};
    const ua = String(sub.userAnswer == null ? '' : sub.userAnswer).trim();
    const ok = ua !== '' && ua === String(q.answer);
    if (ok) correct += 1;
    return {
      questionId: q.questionId,
      content: q.content,
      answer: q.answer,
      userAnswer: ua,
      status: ok ? 1 : 2,          // 1=对 2=错（H5 的 AnswerEnum）
      script: sub.script || q.script || '[]',
    };
  });

  const costTime = Number(examVO.costTime) || 0;
  const total = rec.questions.length;
  const win = correct === total;   // 全对即胜

  rec.submitted = true;
  rec.submittedAt = Date.now();
  rec.correctCnt = correct;
  rec.costTime = costTime;
  rec.win = win;
  s.stats.totalMatches += 1;

  // 记到榜单（按 grade 无关的全局榜；真实业务里按年级分榜，这里简化为一张）
  const rankKey = String(rec.pointId);
  if (!Array.isArray(s.ranks[rankKey])) s.ranks[rankKey] = [];
  s.ranks[rankKey].push({
    userId: 0,
    name: '我',
    pkIdStr,
    score: correct,
    costTime,
    at: Date.now(),
  });
  save();

  return {
    ok: true,
    result: {
      pkIdStr,
      pointId: rec.pointId,
      pointName: rec.pointName,
      questionCnt: total,
      correctCnt: correct,
      costTime,
      win,
      /** H5 结算页拿它渲染逐题明细 */
      questions: graded,
      examVO: {
        pkIdStr,
        pointId: rec.pointId,
        pointName: rec.pointName,
        questionCnt: total,
        correctCnt: correct,
        costTime,
        questions: graded,
      },
    },
  };
}

/**
 * 历史战绩（结算页 `history/detail?pkIdStr=X` 的数据源）。
 * H5 的 `isFromHistory=true` 分支会读它 —— 只填 examVO，不提交。
 */
function matchDetail(pkIdStr) {
  const s = load();
  const rec = s.matches[String(pkIdStr)];
  if (!rec) return null;
  return {
    pkIdStr: rec.pkIdStr,
    pointId: rec.pointId,
    pointName: rec.pointName,
    questionCnt: rec.questionCnt,
    correctCnt: rec.correctCnt || 0,
    costTime: rec.costTime || 0,
    win: !!rec.win,
    questions: rec.questions.map((q) => ({
      questionId: q.questionId,
      content: q.content,
      answer: q.answer,
      userAnswer: '',
      status: 0,
      script: q.script || '[]',
    })),
  };
}

/* ------------------------------------------------------------------ 首页 */

/**
 * 首页数据。字段名对齐 bundle 里的原版开发 mock（`index-legacy.DqAYjRZL.js`），
 * 那是字段结构的权威参考 —— 少一个字段页面就白屏。
 */
function buildHome(grade, opts = {}) {
  const user = opts.user || {};
  const s = load();
  const pointList = TOPICS.map((t) => ({
    pointId: t.pointId,
    pointName: t.name,
    winCount: 0,
  }));

  const played = Object.keys(s.matches).length;

  return {
    baseUserInfoVO: {
      avatarUrl: opts.avatarUrl || '',
      userId: Number(user.userId) || 0,
      userName: user.userName || '私服玩家',
      userPendantUrl: '',
    },
    capacity: 9999,
    weekWinCount: 0,
    totalWinCount: played,
    nextTitleTarget: { maxWinCount: 40, minWinCount: 3, title: '口算达人' },
    pointList,
    userTag: 0,
    grade: Number(grade) || 1,
    unloginPkEnable: true,
    isLogin: true,
    /** 部分页面读它决定要不要弹「登录后开始PK」 */
    login: true,
    /** 赛季入口开关（H5 的 SchoolSeasonEntry 读 feature，这里给个兜底） */
    activityInfo: null,
    opponents: [],
    multiUserList: [],
  };
}

/** 榜单（`game/rank`）。返回结构对齐 H5 的 rank 页。 */
function buildRank(opts = {}) {
  const s = load();
  const key = String(opts.pointId || opts.biz || 'all');
  const rows = Array.isArray(s.ranks[key]) ? s.ranks[key].slice() : [];

  // 按「正确数降序、耗时升序」排
  rows.sort((a, b) => (b.score - a.score) || (a.costTime - b.costTime));
  const rankList = rows.slice(0, 100).map((r, i) => ({
    rank: i + 1,
    userId: r.userId,
    name: r.name,
    avatarUrl: '',
    score: r.score,
    costTime: r.costTime,
  }));

  return {
    rankList,
    myRank: rankList.find((r) => r.userId === 0) || null,
    rankVersion: 'local-1',
    total: rankList.length,
  };
}

/* ------------------------------------------------------------- 加解密封装 */

/** 明文对象 → 设备口径密文 Buffer（H5 用 dataDecrypt 桥解开）。 */
function seal(obj) {
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  return native.encodeSubmitBody(plain);
}

/** H5 交来的密文 Buffer → 明文对象。失败返回 null。 */
function open(buf) {
  if (!buf || buf.length < 2) return null;
  if (!keystream.available()) return null;
  let dec;
  try { dec = keystream.xorEncode(buf); } catch (e) { return null; }
  // XOR 后应是 gzip
  if (dec[0] === 0x1f && dec[1] === 0x8b) {
    try { return JSON.parse(zlib.gunzipSync(dec).toString('utf8')); } catch (e) { return null; }
  }
  // 少数情况直接是 JSON
  if (dec[0] === 0x7b) {
    try { return JSON.parse(dec.toString('utf8')); } catch (e) { return null; }
  }
  // 兜底：也许 H5 直接传了明文 JSON
  if (buf[0] === 0x7b) {
    try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
  }
  return null;
}

/* ----------------------------------------------------------------- 路由 */

/**
 * 判断一个请求路径是否属于私服。
 * 支持带 `/api` 前缀（H5 的 `{client}` 会被换成 `api`）。
 */
function isLocalApi(p) {
  return /^\/leo-game-pk\/(api|\{client\})\//.test(p) ||
         /^\/leo-star\/(api|\{client\})\//.test(p) ||
         /^\/leo-activity\/(api|\{client\})\//.test(p);
}

/** 取 pathname（去掉 query）。 */
function pathOf(url) {
  return String(url || '').split('?')[0];
}

/**
 * 处理一个私服请求。
 *
 * @param {object} o
 * @param {string} o.method  GET/POST/PUT/...
 * @param {string} o.url     原始 url（含 query）
 * @param {Buffer} o.rawBody 原始请求体
 * @param {object} [o.user]  当前登录用户（可选）
 * @returns {null | {status:number, headers?:object, body:Buffer|string}}
 *          返回 null 表示「不是私服的活，交回上层」
 */
function handle(o) {
  const { method, url } = o;
  const p = pathOf(url);
  if (!isLocalApi(p)) return null;

  const q = {};
  {
    const i = String(url).indexOf('?');
    if (i >= 0) {
      for (const kv of String(url).slice(i + 1).split('&')) {
        if (!kv) continue;
        const j = kv.indexOf('=');
        const k = j < 0 ? kv : kv.slice(0, j);
        const v = j < 0 ? '' : kv.slice(j + 1);
        try { q[decodeURIComponent(k)] = decodeURIComponent(v); }
        catch (e) { q[k] = v; }
      }
    }
  }

  const json = (status, obj) => ({
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(JSON.stringify(obj), 'utf8'),
  });

  /* ---- 首页 ---- */
  if (/\/(math|english|poetry)\/pk\/home$/.test(p) && method === 'GET') {
    return json(200, buildHome(q.grade, o));
  }

  /* ---- 出题（match/v2，密文响应） ---- */
  if (/\/math\/pk\/match\/v2$/.test(p) && method === 'POST') {
    const m = makeMatch({ pointId: q.pointId, questionCount: q.questionCount });
    // H5 期望的是**原始分包**，不是 JSON 包装
    const payload = {
      pkIdStr: m.pkIdStr,
      pointId: m.pointId,
      pointName: m.pointName,
      ruleType: m.ruleType,
      questionCnt: m.questionCnt,
      examVO: m.examVO,
    };
    return {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: seal(payload),
    };
  }

  /* ---- 收卷判分（submit，请求体是密文） ---- */
  if (/\/math\/pk\/submit$/.test(p) && (method === 'PUT' || method === 'POST')) {
    const body = open(o.rawBody);
    if (!body) {
      return json(400, { code: 400, message: '提交体解密失败（不是有效的设备口径密文）' });
    }
    const r = gradeSubmit(body);
    if (!r.ok) return json(400, { code: 400, message: r.message });
    return json(200, { code: 200, message: 'ok', data: r.result });
  }

  /* ---- 结算页历史明细 ---- */
  if (/\/math\/pk\/history\/detail$/.test(p) && method === 'GET') {
    const d = matchDetail(q.pkIdStr);
    if (!d) return json(404, { code: 404, message: '对局不存在' });
    return json(200, { code: 200, message: 'ok', data: d });
  }

  /* ---- 排行榜 ---- */
  if (/\/game\/rank$/.test(p) && method === 'GET') {
    return json(200, { code: 200, message: 'ok', data: buildRank(q) });
  }

  /* ---- 其余接口：给一个「成功但空」的通用应答，避免 H5 卡住 ---- */
  // 这些都是首页/结算页并发拉的周边接口（成就、道具、签到等）。
  // 私服不实现它们，但要回 200 让页面能渲染出来。
  return json(200, { code: 200, message: 'ok', data: {} });
}

/* ------------------------------------------------------------------ 导出 */

module.exports = {
  handle,
  isLocalApi,
  // 便于测试与后台调用
  makeMatch,
  gradeSubmit,
  matchDetail,
  buildHome,
  buildRank,
  seal,
  open,
  load,
  save,
  /** 题库/对局的后台管理用 */
  state: () => load(),
  reset() {
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    save();
    return state;
  },
  TOPICS,
};