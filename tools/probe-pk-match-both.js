#!/usr/bin/env node
'use strict';
/**
 * PK 出题对照 —— 用 pk-node 的**正确链路**（POST + pkH5Headers + sign）。
 *
 * ## 背景
 *
 * pk-node `buildUrl` 的注释（2026-10-08）：
 *   「真机 353 个请求里，platform/version/vendor/webviewVersion/whRatio
 *     在任何服务下都是**同一组值**。旧代码分主域/PK 两套表，两套都错 → 被判异构。
 *     唯一差异：主域补 isBackground，PK 不补。」
 *
 * 而本项目 App 的 `PkProtocol` 仍是**旧的两套表**：
 *   platform=android35 / version=3.143.1 / vendor=fenbi / webviewVersion=110 / whRatio=1.78
 *
 * 本实验：用真机会话 cookie，分别跑
 *   ① pk-node 现链路（统一表）
 *   ② 手工构造 App 旧口径（同 POST + 同头）
 * 看哪个能出题。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));
const leo = require(path.join(ROOT, 'src', 'leo'));
const config = require(path.join(ROOT, 'src', 'config'));

const cookies = JSON.parse(fs.readFileSync('/tmp/dev_cookies.json', 'utf8'));

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(88)); line(t); line('='.repeat(88)); }

const POINT = 70;

(async () => {
  hr('pk-node 现链路（统一表）—— pkMatch / pkMatchV2');

  line('  PK.commonQuery = ' + JSON.stringify(config.PK.commonQuery));

  for (const fn of ['pkMatch', 'pkMatchV2']) {
    const jar = new CookieJar(JSON.parse(JSON.stringify(cookies)));
    try {
      const r = await leo[fn](jar, POINT, {});
      const ok = r.status === 200;
      line('');
      line('  ' + (ok ? '✅' : '❌') + ' ' + fn + ' → HTTP ' + r.status);
      line('    body: ' + String(r.text || '').slice(0, 260).replace(/\s+/g, ' '));
    } catch (e) {
      line('  ❌ ' + fn + ' 异常：' + ((e && e.message) || e));
    }
    await new Promise((res) => setTimeout(res, 2500));
  }

  hr('手工构造 App 旧口径（POST + 同一套头）');

  const APP_Q = [
    ['_productId', '611'],
    ['platform', 'android35'],
    ['version', '3.143.1'],
    ['vendor', 'fenbi'],
    ['av', '5'],
    ['deviceCategory', 'phone'],
    ['webviewVersion', '110'],
    ['whRatio', '1.78'],
  ];

  const sp = new URLSearchParams();
  for (const [k, v] of APP_Q) sp.set(k, v);
  sp.set('pointId', String(POINT));
  sp.set('triggerPeakMatch', '0');

  const jar2 = new CookieJar(JSON.parse(JSON.stringify(cookies)));
  const url = 'https://xyks.yuanfudao.com/leo-game-pk/android/math/pk/match/v2?' + sp.toString();
  try {
    const r = await request({
      url, method: 'POST', jar: jar2, rawBody: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 15; DCO-AL00 Build/V417IR; wv) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 ' +
          'Mobile Safari/537.36 YuanSouTiKouSuan/3.143.1',
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://xyks.yuanfudao.com',
        'X-Requested-With': 'com.fenbi.android.leo',
        Referer: 'https://xyks.yuanfudao.com/bh5/leo-web-oral-pk/exercise.html',
      },
    });
    line('  ' + (r.status === 200 ? '✅' : '❌') + ' HTTP ' + r.status);
    line('    body: ' + String(r.text || '').slice(0, 260).replace(/\s+/g, ' '));
  } catch (e) {
    line('  ❌ 异常：' + ((e && e.message) || e));
  }

  hr('说明');
  line('  · 手工构造没走 pk-node 的 sign 注入，417 只能说明「没签名」');
  line('  · 关键看 pk-node 现链路（①）能不能出题');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });