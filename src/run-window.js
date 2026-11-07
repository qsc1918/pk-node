'use strict';
/**
 * 运行窗口（run window）—— 把「刷多久 / 每天几点到几点」统一成主循环能用的约束。
 *
 * 三种停止条件（`config.window.mode`）：
 *
 *   rounds   不限时间，按局数跑（**旧行为，默认**；不写 window 字段时就是这个）
 *   duration 从开始跑算起，够 `durationMs` 就停。到点时**不打断在途的那一局**，
 *            等它跑完再收尾 —— 用户的原话是「把那一局搞完之后就直接停」。
 *   daily    每天 [startMin, endMin) 之间一直刷；窗口外挂起等待，
 *            窗口一到自动接着刷，第二天再自动开始。
 *
 * ## 为什么把判断放在主循环里，而不是外面挂个定时器
 *
 * 一局是异步的（出题 → 作答 → 提交 → 结算，几秒到几十秒）。外部定时器只有两种选择：
 * 到点硬杀（把半局打废、还可能把提交打进频控），或者等（那就等于多跑一局）。
 * 主循环每轮边界判断一次，天然满足「这一局搞完就停」，也天然可中断（stop/pause 走 signal）。
 *
 * ## 状态机
 *
 *   running ──(窗口外)──> waiting ──(窗口开启)──> running
 *      │                     │
 *      └──(到点/局数满)──────┴──> done
 *
 * `waiting` 是「活着但在等时间」，不是暂停 —— 不需要人工点「继续」。
 */

/** 与 server.js 的 MAX_ROUNDS 保持一致（窗口模式下用它当「不限局数」）。 */
const MAX_ROUNDS = 100000;

/** 限时模式的上限：30 天（防手滑填成天文数字）。 */
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/** 最短限时：1 分钟。 */
const MIN_DURATION_MS = 60 * 1000;

/** 星期名（0 = 周日，与 Date#getDay 一致）。 */
const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 把「08:00 / 8:00 / 0800 / 480(分钟)」统一成分钟数；非法返回 null。 */
function parseHM(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return validMin(v);
  const s = String(v).trim();
  if (!s) return null;
  let m = /^(\d{1,2})\s*[:：.．]\s*(\d{1,2})$/.exec(s);
  if (m) return validMin(Number(m[1]) * 60 + Number(m[2]));
  m = /^(\d{1,2})(\d{2})$/.exec(s);
  if (m) return validMin(Number(m[1]) * 60 + Number(m[2]));
  m = /^(\d{1,2})$/.exec(s);
  if (m) return validMin(Number(m[1]) * 60);
  return null;
}

function validMin(n) {
  if (!Number.isFinite(n)) return null;
  const v = Math.floor(n);
  if (v < 0 || v > 1439) return null;
  return v;
}

/** 分钟数 → "08:00"。 */
function fmtHM(min) {
  const v = ((Math.floor(Number(min) || 0) % 1440) + 1440) % 1440;
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

/** 毫秒 → "1 小时 20 分" / "3 分 12 秒"（日志与任务页共用）。 */
function fmtDuration(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

/**
 * 把 config 里的 `window` 归一化成内部结构；不需要窗口时返回 null。
 *
 * 容错：既接受服务端已经算好的 `{mode,startMin,endMin,days}`，
 * 也接受前端直传的 `{mode:'daily', start:'08:00', end:'20:00'}`（自己 parse）。
 *
 * @param {object|null|undefined} raw
 * @returns {{mode:'duration',durationMs:number}|{mode:'daily',startMin:number,endMin:number,days:number[]}|null}
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;

  if (raw.mode === 'duration') {
    let ms = Math.floor(Number(raw.durationMs) || 0);
    if (!Number.isFinite(ms) || ms <= 0) {
      // 兼容「小时数」写法（durationHours）
      const h = Number(raw.durationHours);
      if (Number.isFinite(h) && h > 0) ms = Math.floor(h * 3600 * 1000);
    }
    if (!Number.isFinite(ms) || ms <= 0) return null;
    ms = Math.min(Math.max(ms, MIN_DURATION_MS), MAX_DURATION_MS);
    return { mode: 'duration', durationMs: ms };
  }

  if (raw.mode === 'daily') {
    const startMin = raw.startMin != null ? validMin(Number(raw.startMin)) : parseHM(raw.start);
    const endMin = raw.endMin != null ? validMin(Number(raw.endMin)) : parseHM(raw.end);
    if (startMin == null || endMin == null) return null;
    if (startMin === endMin) return null;
    let days = Array.isArray(raw.days)
      ? raw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];
    days = Array.from(new Set(days)).sort((a, b) => a - b);
    // 不填 / 填满一周 → 每天都跑
    if (days.length === 0 || days.length === 7) days = [0, 1, 2, 3, 4, 5, 6];
    return { mode: 'daily', startMin: startMin, endMin: endMin, days: days };
  }

  return null;
}

/** 窗口是否「按时间无限跑」（即局数不该成为限制）。 */
function isWindowed(w) {
  return !!(w && (w.mode === 'duration' || w.mode === 'daily'));
}

/**
 * 限时模式的绝对截止时刻。
 *
 * 优先用「剩余时长」（暂停后继续 / 服务重启后恢复），这样「刷 1 小时」暂停 10 分钟
 * 再继续，还剩原来剩下的那段，而不是重新数 1 小时。
 *
 * @param {object} w  normalize() 的结果
 * @param {number} [now]
 * @param {number} [remainingMs] 上次暂停时落库的剩余时长
 * @returns {number|null}
 */
function durationDeadline(w, now, remainingMs) {
  if (!w || w.mode !== 'duration') return null;
  const t = Number(now) || Date.now();
  const remain = Number(remainingMs);
  if (Number.isFinite(remain) && remain > 0) return t + remain;
  return t + w.durationMs;
}

/**
 * 当前时刻是否在每日窗口内。
 *
 * 跨午夜窗口（如 22:00 → 02:00）的归属：凌晨那段算**前一天**的窗口，
 * 所以星期判断要用 (day-1+7)%7 —— 否则「只在周五 22:00–02:00 刷」会漏掉周六凌晨。
 *
 * @param {object} w
 * @param {number} [ts]
 * @returns {boolean}
 */
function isOpen(w, ts) {
  if (!w || w.mode !== 'daily') return true;
  const d = new Date(ts == null ? Date.now() : ts);
  const day = d.getDay();
  const min = d.getHours() * 60 + d.getMinutes();
  const s = w.startMin;
  const e = w.endMin;

  if (s < e) {
    // 同日窗口
    return w.days.indexOf(day) >= 0 && min >= s && min < e;
  }
  // 跨午夜窗口
  if (min >= s) return w.days.indexOf(day) >= 0;
  if (min < e) return w.days.indexOf((day + 6) % 7) >= 0;
  return false;
}

/**
 * 下一个窗口开启时刻（毫秒时间戳）；找不到（配置异常）返回 null。
 * 逐分钟试探，最多看 8 天 —— 比手写「加一天再算」更不容易在跨午夜/跨周处算错。
 *
 * @param {object} w
 * @param {number} [ts]
 */
function nextOpenAt(w, ts) {
  if (!w || w.mode !== 'daily') return ts == null ? Date.now() : ts;
  const from = new Date(ts == null ? Date.now() : ts);
  from.setSeconds(0, 0);
  let t = from.getTime() + 60 * 1000;          // 从下一分钟开始找
  const limit = t + 8 * 24 * 60 * 60 * 1000;
  while (t < limit) {
    if (isOpen(w, t)) return t;
    t += 60 * 1000;
  }
  return null;
}

/** 当前窗口的结束时刻（窗口内才有效）；用于「本段还能刷多久」。 */
function currentCloseAt(w, ts) {
  if (!w || w.mode !== 'daily') return null;
  const now = ts == null ? Date.now() : ts;
  if (!isOpen(w, now)) return null;
  const d = new Date(now);
  d.setSeconds(0, 0);
  let t = d.getTime() + 60 * 1000;
  const limit = t + 8 * 24 * 60 * 60 * 1000;
  while (t < limit) {
    if (!isOpen(w, t)) return t;
    t += 60 * 1000;
  }
  return null;
}

/** 人能读的窗口描述（任务页 / 日志用）。 */
function describe(w) {
  if (!w) return '按局数';
  if (w.mode === 'duration') return `限时 ${fmtDuration(w.durationMs)}`;
  if (w.mode === 'daily') {
    const dayText = w.days.length === 7 ? '每天' : w.days.map((d) => DAY_NAMES[d]).join('、');
    return `${dayText} ${fmtHM(w.startMin)}–${fmtHM(w.endMin)}`;
  }
  return '按局数';
}

/**
 * 睡到下一个窗口开启（可中断）。
 *
 * 分片睡（每片最多 60 秒）而不是一觉睡到点，是为了：
 *   ① 系统时间被改 / 夏令时切换时能重新判断；
 *   ② 每分钟回一次心跳日志，用户能看见「还在等，没死」。
 *
 * @param {object} w
 * @param {object} o
 * @param {AbortSignal} [o.signal]
 * @param {(ev:object)=>void} [o.onEvent] 日志回调
 * @param {()=>boolean} [o.isStopped] 每片结束后问一次「是不是被停了」
 * @returns {Promise<boolean>} true = 窗口开了；false = 被停止（调用方应直接收尾）
 */
async function waitForOpen(w, o) {
  const opt = o || {};
  const emit = typeof opt.onEvent === 'function' ? opt.onEvent : () => {};
  const isStopped = typeof opt.isStopped === 'function' ? opt.isStopped : () => false;
  const sleep = (ms) => sleepAbortable(ms, opt.signal);

  for (let guard = 0; guard < 8 * 24 * 60; guard++) {
    if (isStopped()) return false;
    const now = Date.now();
    if (isOpen(w, now)) return true;

    const next = nextOpenAt(w, now);
    if (next == null) return false;
    const waitMs = Math.max(1000, next - now);
    emit({
      type: 'status',
      waiting: true,
      message: `窗口外：现在 ${fmtHM(new Date(now).getHours() * 60 + new Date(now).getMinutes())}，` +
        `等到 ${fmtHM(new Date(next).getHours() * 60 + new Date(next).getMinutes())} 自动开刷` +
        `（还有 ${fmtDuration(waitMs)}）`,
      nextOpenAt: next,
      waitMs: waitMs,
      at: now,
    });

    // 分片睡：每片最多 60 秒
    let left = waitMs;
    while (left > 0) {
      if (isStopped()) return false;
      const step = Math.min(left, 60 * 1000);
      try {
        await sleep(step);
      } catch (e) {
        if (e && (e.aborted || e.name === 'AbortError')) return false;
        throw e;
      }
      left -= step;
      if (isOpen(w, Date.now())) return true;
    }
  }
  return isOpen(w, Date.now());
}

/** 可中断的 sleep（AbortSignal）。与 pk-engine.sleepAbortable 同语义，这里独立实现避免循环依赖。 */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortedError());
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, Number(ms) || 0));
    function onAbort() {
      clearTimeout(timer);
      reject(abortedError());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortedError() {
  const e = new Error('已中断');
  e.aborted = true;
  e.name = 'AbortError';
  return e;
}

module.exports = {
  MAX_ROUNDS,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  DAY_NAMES,
  parseHM,
  fmtHM,
  fmtDuration,
  normalize,
  isWindowed,
  durationDeadline,
  isOpen,
  nextOpenAt,
  currentCloseAt,
  describe,
  waitForOpen,
  sleepAbortable,
};
