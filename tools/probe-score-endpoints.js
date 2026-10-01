#!/usr/bin/env node
'use strict';
/*
 * 用**真机 cookie**直接打 homepage 与 rank/pre-fetch，钉死「刷分读数」到底是哪个字段。
 *
 * 用法：node tools/probe-score-endpoints.js
 * 输出的 URL 里已含 sign（纯 JS 模拟算出），可直接 curl。
 */
const ex = require('../src/exercise');
const leo = require('../src/leo');

// 真机 leo_session.xml 里的 cookie（ks_* 是 Keystore 密文，无法在外部解密，先不带）。
const COOKIE = [
  'sid=7012770506069852030',
  'sess=9sxXN3EQzhWS7Yjvrp1UJW5Gs25EQwZarVig/wrVEaZ3TRxY6Twej8BTEJ04lYQO',
  'userid=1066052990',
  'g_sess=VI17KXB8MnED74HX6iTjXdJ3a+1hekz11k1V3sZ0wimzJ7CemoiEHQPil15rX9RL0Zp+RKTZWqChiWj9PxGBVES4YxWsZbXzSYZMO0l7nkMFjKx2TEOxj0QKwao3yPByBD1jovVS77DeYOQxFPFf0Q==',
  'persistent=OuvlpY56iRgeKkvlk73xBfgmPPn8A+/3biyV+rwEgeIeXA7CoLiMWGzoof9xInI+nXwxP2SuVfCRBqAlCtxm9WxM25YxeXryFtZ73hujEec=',
  'YFD_U=-7346957829554004692',
].join('; ');

(async () => {
  const urls = {
    homepage: ex.buildExerciseUrl('/leo-star/android/exercise/homepage'),
    prefetch: ex.buildExerciseUrl('/leo-star/android/exercise/rank/pre-fetch'),
    taskHome: ex.buildExerciseUrl('/leo-star/android/exercise/task/home'),
  };
  for (const [k, v] of Object.entries(urls)) {
    console.log(k + ' = ' + v);
  }
  console.log('COOKIE = ' + COOKIE);
  console.log('UA = ' + ex.exerciseUa());
  console.log('HEADERS = ' + JSON.stringify(ex.exerciseHeaders()));
})();