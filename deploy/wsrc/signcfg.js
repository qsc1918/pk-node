// Worker 端配置常量。
//
// 全部数值**逐字对齐**本机 pk-node（src/config.js / src/leo.js），
// 因为它们是从真机抓包验证出来的；改任何一个都可能导致 417/400。

export const LEO_BASE = 'https://xyks.yuanfudao.com';

/** PK 端点公共参数（真机 PK 出题 URL 逐字）。 */
export const PK_COMMON = [
  ['platform', 'android35'],
  ['version', '3.143.1'],
  ['vendor', 'fenbi'],
  ['av', '5'],
  ['deviceCategory', 'phone'],
  ['webviewVersion', '110'],
  ['whRatio', '1.78'],
];

/** 练习等主域端点公共参数（服务端只放行 3.140.1 + android37）。 */
export const MAIN_COMMON = [
  ['platform', 'android37'],
  ['version', '3.140.1'],
  ['vendor', 'UC'],
  ['av', '5'],
  ['deviceCategory', 'phone'],
  ['webviewVersion', '150'],
  ['whRatio', '2.17'],
  ['isBackground', '0'],
];

/** 走 MAIN_COMMON 的路径前缀。 */
export const MAIN_PREFIXES = [
  '/leo-gateway', '/leo-profile', '/leo-auth', '/leo-star',
  '/leo-math', '/leo-reward', '/leo-account',
];

/** 产品线 id：真机 PK 出题用 611（不是 631），且不带 _appId。 */
export const PRODUCT_ID = '611';

/** 设备（UA 用）：品牌 + 型号 + Android 版本号（注意用 17，不是 sdk 37）。 */
export const DEVICE = { brand: 'Redmi', model: '25053RT47C', uaSdk: 17, scale: '3.25' };

/** 风控头（真机抓包逐字）。x-shepherd-did 为空时**不发**（空值可能被判异常）。 */
export const RISK_HEADERS = {
  'X-XYKS-REQ-NETWORK-ENV': 'mobile',
  'x-shepherd-sessionid': '0',
};

/** PK 端点路径。 */
export const PATH = {
  matchV2: '/leo-game-pk/android/math/pk/match/v2',
  submit: '/leo-game-pk/android/math/pk/submit',
  historyDetail: '/leo-game-pk/android/math/pk/history/detail',
  pkHome: '/leo-game-pk/api/math/pk/home',
  userInfosContext: '/leo-auth/android/user-infos/context',
};

/** 提交成本时间下限（毫秒）——服务端要求非 0。 */
export const MIN_COST_TIME_MS = 5;
