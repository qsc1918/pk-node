#!/usr/bin/env node
'use strict';
/*
 * 用真机 cookie 实测：rank/login/attend（经验上报）到底增加哪个字段。
 *
 * 步骤：读 pre-fetch.curWeekScore → 发一条 attend(delta=1) → 再读 → 打印差值。
 *
 * 用法：node tools/probe-attend-effect.js [delta] [ruleType]
 */
const ex = require('../src/exercise');
const leo = require('../src/leo');

const COOKIE_HEADER = [
  'sid=7012770506069852030',
  'sess=9sxXN3EQzhWS7Yjvrp1UJW5Gs25EQwZarVig/wrVEaZ3TRxY6Twej8BTEJ04lYQO',
  'userid=1066052990',
  'g_sess=VI17KXB8MnED74HX6iTjXdJ3a+1hekz11k1V3sZ0wimzJ7CemoiEHQPil15rX9RL0Zp+RKTZWqChiWj9PxGBVES4YxWsZbXzSYZMO0l7nkMFjKx2TEOxj0QKwao3yPByBD1jovVS77DeYOQxFPFf0Q==',
  'persistent=OuvlpY56iRgeKkvlk73xBfgmPPn8A+/3biyV+rwEgeIeXA7CoLiMWGzoof9xInI+nXwxP2SuVfCRBqAlCtxm9WxM25YxeXryFtZ73hujEec=',
  'YFD_U=-7346957829554004692',
].join('; ');

(async () => {
  const delta = Number(process.argv[2]) || 1;
  const rt = Number(process.argv[3]) || 0;
  const jar = new leo.CookieJar([]);
  jar.importHeader(COOKIE_HEADER, 'xyks.yuanfudao.com');

  const pf0 = await ex.rankPrefetch(jar);
  const before = pf0.json && pf0.json.data ? pf0.json.data.curWeekScore : null;
  console.log('attend 前 curWeekScore =', before);

  const r = await ex.attend(jar, delta, rt);
  console.log('attend delta=' + delta + ' ruleType=' + rt + ' → HTTP', r.status);
  console.log('  body:', String(r.text).slice(0, 300));

  await new Promise((s) => setTimeout(s, 1500));
  const pf1 = await ex.rankPrefetch(jar);
  const after = pf1.json && pf1.json.data ? pf1.json.data.curWeekScore : null;
  console.log('attend 后 curWeekScore =', after, ' 差值 =', (after != null && before != null) ? after - before : '?');

  const hp = await ex.homepage(jar);
  console.log('homepage:', JSON.stringify(hp.json && hp.json.data));
  process.exit(0);
})();