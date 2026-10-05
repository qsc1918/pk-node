'use strict';
/**
 * race-probe.js —— 开学季竞速「真实服务器」探针（开发/取证用，不进发布包）。
 *
 * 用法：
 *   node tools/race-probe.js home [leoId]        # 只拉活动主页（知识点/活动时间）
 *   node tools/race-probe.js rank [leoId]        # 拉榜单（全国）
 *   node tools/race-probe.js match [leoId]       # 走一遍匹配 → 打印 MATCH_RESULT
 *   node tools/race-probe.js race [leoId] [minS][maxS]   # 完整一局（可选提交延迟秒数）
 *
 * 依赖本机 data/pk-node.sqlite 里已导入的小猿账号（无 leoId 时取第一个）。
 */

const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));

const db = require('../src/db');
const jobs = require('../src/jobs');
const ss = require('../src/school-season');

db.init();

function pickAccount(leoId) {
  const users = db.listUsers();
  for (const u of users) {
    const list = db.listLeoAccounts(u.id);
    if (!list.length) continue;
    if (!leoId) return list[0];
    const hit = list.find((a) => Number(a.id) === Number(leoId));
    if (hit) return hit;
  }
  return null;
}

(async () => {
  const cmd = process.argv[2] || 'home';
  const leoId = process.argv[3] ? Number(process.argv[3]) : 0;
  const acc = pickAccount(leoId);
  if (!acc) {
    console.error('没有可用的小猿账号（先在 pk-node 里导入一个）');
    process.exit(2);
  }
  console.log('=== 账号:', acc.id, acc.name, '===');
  const jar = jobs.jarOf(acc);

  if (cmd === 'home') {
    const r = await ss.home(jar, { grade: acc.grade || 2 });
    console.log('HTTP', r.status);
    console.log(JSON.stringify(r.json, null, 2).slice(0, 4000));
    if (!r.json) console.log('RAW:', String(r.text).slice(0, 800));
    process.exit(0);
  }

  if (cmd === 'rank') {
    const h = await ss.home(jar, { grade: acc.grade || 2 });
    const pointId = (h.json && h.json.points && h.json.points[0] && h.json.points[0].pointId) || 0;
    const r = await ss.rank(jar, { pointId, scope: 1 });
    console.log('HTTP', r.status, 'pointId=', pointId);
    console.log(JSON.stringify(r.json, null, 2).slice(0, 6000));
    if (!r.json) console.log('RAW:', String(r.text).slice(0, 800));
    process.exit(0);
  }

  if (cmd === 'match') {
    const h = await ss.home(jar, { grade: acc.grade || 2 });
    if (!h.json) { console.error('home 失败', h.status, String(h.text).slice(0, 300)); process.exit(1); }
    const point = h.json.points[0];
    const traceId = ss.randomTraceId19();
    const url = ss.buildWsUrl('/game/match/v2', { sessionId: String(h.json.gameSessionId || 0), traceId });
    console.log('WS url:', url);
    const ws = new ss.WsClient({
      url,
      headers: {
        Cookie: jar.headerFor('xyks.yuanfudao.com', '/'),
        Origin: 'https://xyks.yuanfudao.com',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 15; DCO-AL00 Build/V417IR; wv) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 Mobile Safari/537.36 YuanSouTiKouSuan/3.143.1',
      },
      logPrefix: 'match',
      onMessage: (m) => {
        console.log('<<', JSON.stringify(m).slice(0, 600));
      },
    });
    await ws.connect(15000);
    console.log('>> gen =', ws.gen);
    const reqId = ws.send(11, { biz: 10, knowledgeId: point.pointId, questionCount: point.expectedQuestionCnt || 20 });
    console.log('>> MATCH_REQUEST reqId=', reqId);
    setTimeout(() => { ws.close(); process.exit(0); }, 20000);
    return;
  }

  if (cmd === 'race') {
    const minS = Number(process.argv[4] || 0.5);
    const maxS = Number(process.argv[5] || 1.0);
    const r = await ss.runOneRace(jar, {
      grade: acc.grade || 2,
      pointId: 0,
      answerDelayMinMs: minS * 1000,
      answerDelayMaxMs: maxS * 1000,
      useSample: true,
      battleMaxMs: 4 * 60 * 1000,
    }, (ev) => {
      console.log('[' + (ev.type || '') + ']', ev.message || JSON.stringify(ev).slice(0, 200));
    });
    console.log('\n=== 结果 ===');
    console.log(JSON.stringify({ ok: r.ok, message: r.message, answers: r.answers && r.answers.length, finish: r.finish }, null, 2).slice(0, 2000));
    process.exit(r.ok ? 0 : 1);
  }

  console.error('未知命令:', cmd);
  process.exit(2);
})().catch((e) => {
  console.error('探针异常:', e && e.stack || e);
  process.exit(1);
});