/**
 * 从下载好的 H5 资产里做「页面 → 模块 → API / 桥方法」映射。
 * 目的：一次性看清 pkh5 的所有逻辑与相关 API（不再靠猜）。
 */
const fs = require('fs');
const path = require('path');
const DIR = '/tmp/h5all';
const JS = path.join(DIR, 'js');

const APIS = [
  '/leo-game-pk/{client}/math/pk/home',
  '/leo-game-pk/{client}/math/pk/match/v2',
  '/leo-game-pk/{client}/math/pk/submit',
  '/leo-game-pk/{client}/math/pk/multi/submit',
  '/leo-game-pk/{client}/math/pk/history',
  '/leo-game-pk/{client}/math/pk/history/detail',
  '/leo-game-pk/{client}/math/pk/achievement',
  '/leo-game-pk/{client}/math/pk/props/home',
  '/leo-game-pk/{client}/math/pk/reward/claim',
  '/leo-game-pk/{client}/math/challenge/start',
  '/leo-game-pk/{client}/math/challenge/info',
  '/leo-game-pk/{client}/math/challenge/history',
  '/leo-game-pk/{client}/math/challenge/history/detail',
  '/leo-game-pk/{client}/pk/login/sync',
  '/leo-game-pk/{client}/pk/pros/use',
  '/leo-game-pk/{client}/game/rank',
  '/leo-game-pk/{client}/game/homepage',
  '/leo-game-pk/{client}/english/pk/home',
  '/leo-game-pk/{client}/english/pk/submit',
  '/leo-game-pk/{client}/poetry/pk/home',
  '/leo-game-pk/{client}/word/eliminate/submit',
  '/leo-star/{client}/exercise/rank/pk/rate',
  '/leo-star/{client}/exercise/rank/list',
  '/leo-star/{client}/exercise/rank/pre-fetch',
  '/leo-star/{client}/exercise/task/home',
  '/leo-star/{client}/anti-addiction',
  '/leo-activity/{client}/backpack',
  '/leo-activity/{client}/activity/pk/daily/award',
  '/leo-profile/api/user-infos/context',
  '/leo-reward/{client}/points/type/41',
  '/leo-reward/{client}/points/type/33',
  '/solar-vip/api/users/self',
  '/api/current-user-context',
];

const BRIDGE = ['getUserInfo','getWebViewInfo','getDeviceId','getDeviceInfo','getOrionConfig','requestConfig',
  'dataDecrypt','dataEncrypt','openSchema','openWebView','closeWebView','setLeftButton','setRightButton','setTitle',
  'setOnVisibilityChange','refreshStateView','jsLoadComplete','getFeatureConfig','addFrog','addMergeableKlog',
  'sendEventToNative','getImmerseStatusBarHeight','getUserRights','getVipRightInfo','login','toast','loading',
  'setForceBounceEnable','observeTabChange','ShowPracticeDialogIfNeeded','recognize','callNative','setBounceEnable',
  'getAuthContext','hideNavigation','getSolarContext','setNavigationBar'];

const files = fs.readdirSync(JS).filter((f) => f.endsWith('.js'));
const rows = [];
for (const f of files) {
  const s = fs.readFileSync(path.join(JS, f), 'utf8');
  const apis = APIS.filter((a) => s.indexOf(a) >= 0);
  const br = BRIDGE.filter((b) => s.indexOf(b) >= 0);
  rows.push({ file: f, size: s.length, apis, bridge: br });
}
// 输出
const out = [];
out.push('# pkh5 模块 → API / 桥 映射（共 ' + files.length + ' 个模块）\n');
for (const r of rows.sort((a, b) => b.apis.length - a.apis.length)) {
  if (!r.apis.length && r.bridge.length < 5) continue;
  out.push('## ' + r.file + '  (' + r.size + 'B)');
  if (r.apis.length) out.push('  API: ' + r.apis.map((a) => a.replace('/leo-game-pk/{client}', 'PK').replace('/leo-star/{client}', 'STAR')).join(', '));
  if (r.bridge.length) out.push('  桥 : ' + r.bridge.join(', '));
}
fs.writeFileSync('/tmp/h5all/map.md', out.join('\n'));
console.log(out.join('\n'));
console.log('\n=== 各 API 出现在哪些模块 ===');
for (const a of APIS) {
  const who = rows.filter((r) => r.apis.indexOf(a) >= 0).map((r) => r.file.replace(/^.*?([A-Za-z-]+)-legacy.*$/, '$1'));
  if (who.length) console.log(a.padEnd(48), who.join(', '));
}