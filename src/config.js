'use strict';
/**
 * 全局配置与常量（只读环境变量；持久化数据在 SQLite）。
 */

const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

/**
 * 默认监听地址。
 *
 * ⚠️ 2026-10-03 修复：**原来是 `127.0.0.1`（只监听回环）**，
 * 所以「局域网 IP:8792」「公网 IP:8792」一律连不上 —— 请求在 TCP 层就被拒，
 * 连 401 都收不到（很多人误以为是防火墙/鉴权的锅）。
 *
 * 改成 `0.0.0.0`（监听本机所有网卡）后，同一台机器上的多块网卡都能连：
 *   - 本机        http://127.0.0.1:8792
 *   - 局域网/手机 http://192.168.x.x:8792
 *   - 公网（需路由器做端口映射 / 或用内置 Cloudflare 隧道）
 *
 * 想改回「只监听本机」：`PK_HOST=127.0.0.1`
 * 想只监听某一块网卡（更安全）：`PK_HOST=192.168.3.72`
 */
const DEFAULT_HOST = '0.0.0.0';

/**
 * 本机对外可达的 IPv4 地址（局域网卡 + 公网网卡，排除回环/虚拟内部网卡）。
 * 只用于启动横幅里给出「照着点」的链接，不参与监听。
 */
function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      if (out.indexOf(it.address) < 0) out.push(it.address);
    }
  }
  return out;
}

function envInt(name, def) {
  const v = process.env[name];
  const n = v == null ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const config = {
  root: ROOT,
  /** 监听地址。默认监听所有网卡（局域网/公网可访问）；详见 DEFAULT_HOST 注释。 */
  host: process.env.PK_HOST || DEFAULT_HOST,
  // 默认 8792，避开本机 8791（MT APK MCP 占用）；仍可用 PK_PORT 覆盖。
  port: envInt('PK_PORT', 8792),

  /** SQLite 文件。放在项目 data/ 下，随项目走。 */
  dbFile: process.env.PK_DB || path.join(ROOT, 'data', 'pk-node.sqlite'),

  /** 会话 cookie 名与有效期。 */
  sessionCookie: 'pk_sid',
  sessionTtlMs: envInt('PK_SESSION_TTL_MS', 1000 * 60 * 60 * 24 * 7),

  /** 管理后台默认账号（首次启动写入；之后以库里的为准）。 */
  defaultAdminUser: process.env.PK_ADMIN_USER || 'admin',
  defaultAdminPass: process.env.PK_ADMIN_PASS || 'admin',

  /** 原生资产目录（linker64 / patched so / harness / lre.so）。 */
  nativeDir: path.join(ROOT, 'bin', 'native'),

  /** 小猿主域（业务 + PK）。 */
  leoHost: 'xyks.yuanfudao.com',
  leoBase: 'https://xyks.yuanfudao.com',
  /** 小猿账号域（昵称/头像/年级，不需设备链）。 */
  ytkHost: 'ape-api.yuanfudao.com',
  ytkBase: 'https://ape-api.yuanfudao.com',

  /**
   * 真机设备参数（拼 App 原生 UA 用）。
   *
   * 默认值取本机 `getprop` 实测：
   *   brand=Redmi, model=25053RT47C, sdk=37, density=520 → Scale 3.25。
   *
   * ⚠️ UA 必须真实 —— 它是 417 风控判定的一部分，不要写成 H5 的 Chrome UA。
   */
  device: {
    brand: process.env.PK_DEVICE_BRAND || 'Redmi',
    model: process.env.PK_DEVICE_MODEL || '25053RT47C',
    sdk: envInt('PK_DEVICE_SDK', 37),
    /**
     * UA 里那个「Android NN」的数字。
     *
     * ⚠️ **与 [sdk] 不是一回事**：query 的 `platform=android37` 用 SDK 号，
     * 而原版 UA 写的是 `Android 17`（实测抓包逐字）。两个值必须都按原版来，否则风控判异构。
     */
    uaSdk: envInt('PK_DEVICE_UA_SDK', 17),
    scale: process.env.PK_DEVICE_SCALE || '3.25',
  },

  /**
   * sign 模式：`auto`（默认）/ `on` / `off`。
   * 有 arm64 native（bin/native/lre.so）→ 自动算 sign；没有（Windows/x86）→ 静默不加。
   */
  signMode: process.env.PK_SIGN_MODE || 'auto',

  /**
   * 风控设备标识 `x-shepherd-did`（**需要你自己从本机取一次**）。
   *
   * 真机上由宿主 App 从服务端同步，持久化在
   * `/data/data/com.fenbi.android.leo/files/mmkv/leo_shepherd_id`
   * （key `didKey@v3.68.0@String`）。
   *
   * 取法（需 root）：
   * ```sh
   * strings /data/data/com.fenbi.android.leo/files/mmkv/leo_shepherd_id \
   *   | grep didKey | head -1 | sed 's/.*String%\\$//'
   * ```
   * 然后 `export PK_SHEPHERD_DID=<取到的值>`，或直接改这里的默认值。
   *
   * 本服务不复刻那套 shepherd 同步链路，**直接沿用同机宿主的值**
   * —— 与「导入登录态 cookie」同一思路：同一台设备复用同一份设备级凭据。
   * 留空则不发送该头（PK 系接口不受影响；主域部分端点可能因此 417）。
   */
  shepherdDid: process.env.PK_SHEPHERD_DID || '',


  /** 是否默认启用 cloudflared 穿透（也可在网页里勾选开关）。 */
  tunnelByDefault: process.env.PK_TUNNEL === '1',

  /** cloudflared 可执行文件路径（不存在时会提示下载）。 */
  cloudflaredPath: process.env.PK_CLOUDFLARED || path.join(ROOT, 'bin', 'cloudflared'),
};

/** 是否监听在「所有网卡」= 局域网/公网能访问。用于启动横幅提示与登录限流强度。 */
config.isExposed = (config.host === '0.0.0.0' || config.host === '::' || config.host === '');

/**
 * 关键常量：PK 协议。
 * 全部来自 cn.apixiaoyuan.app 的实测/逆向结论，**不要凭猜改**。
 */
const PK = {
  /**
   * 主域公共参数（缺 sign 会 417）。
   * 逐字来自真机 PK 出题请求；version 必须是 **App 实际版本号**（3.143.1），不是服务端放行版。
   */
  commonQuery: {
    platform: 'android35',
    version: '3.143.1',
    vendor: 'fenbi',
    av: '5',
    deviceCategory: 'phone',
    webviewVersion: '110',
    whRatio: '1.78',
  },
  /**
   * 产品线 id。真机 PK 出题请求用的是 **611**（不是 631），且**不带 `_appId`**。
   */
  productIdDefault: '611',
  productIdPk: '611',

  /**
   * 练习（`/leo-star` `/leo-math` `/leo-reward` 主域端点）公共参数。
   * 主域端点被 `solar-encoder` 拦成 417，**根因是 `version`**：服务端放行 3.140.1 + android37。
   * PK 端点走另一套校验，不受此限，故各自用各自的表。
   */
  exercise: {
    platform: 'android37',
    version: '3.140.1',
    vendor: 'UC',
    av: '5',
    deviceCategory: 'phone',
    webviewVersion: '150',
    whRatio: '2.17',
    isBackground: '0',
    /** 练习一律 611。 */
    productId: '611',
  },
  /** 风控头（真机抓包逐字）。 */
  headers: {
    'X-XYKS-REQ-NETWORK-ENV': 'mobile',
    'x-shepherd-sessionid': '0',
  },

  /**
   * 提交接口独立频控：默认等 10s、最多 2 次。
   *
   * 设备参数（UA）与 `x-shepherd-did` 属于**设备级凭据**，不在本对象里
   * —— 见 [config.device] / [config.shepherdDid]。
   */
  rateLimitBaseMs: 10_000,
  rateLimitMaxWait: 2,
  /**
   * 出题接口的冷却：**≈60s/账号**（实测仍在）。
   *
   * 本字段只是「引擎是否**自动**替你等」的开关 —— 默认 **0**（不等）。
   * 网页侧默认每轮间隔填 0/0，冷却由「出题频控重试」在背景里蹲。
   *
   * 想让引擎自动贴着下沿配速：`PK_MATCH_COOLDOWN_MS=61600`。
   *
   * ⚠️ 练习链路无此冷却（见 `src/exercise.js` 的 `MATCH_COOLDOWN_MS` = 1.5s）。
   */
  matchCooldownMs: envInt('PK_MATCH_COOLDOWN_MS', 0),
  /** 出题撞 400/403 时的重试间隔。 */
  matchRetryIntervalMs: 10_000,
  /** 出题重试的累计上限（超此才判该轮失败）。 */
  matchRetryMaxMs: 120_000,
  /** 冷却估计最多往回缩这么多（避免每次都在窗口边缘白撞一次）。 */
  matchCooldownSafetyMs: 0,
};

/**
 * 最大并行任务数（**任务之间**并行；每个任务内部仍串行）。
 * 默认 0 = 不限制（任务内部串行 + 频控自动退避；并行只各自慢一点）。
 * 仍可用 `PK_MAX_CONCURRENT` 设一个正整数限制。
 */
config.maxConcurrentJobs = envInt('PK_MAX_CONCURRENT', 0);

/**
 * 登录失败限流：同一个来源 IP 在 [loginFailWindowMs] 内失败超过
 * [loginFailMax] 次就临时封禁。
 *
 * 为什么加：一旦服务暴露到局域网/公网（默认 `0.0.0.0`），登录口就成了
 * 撞库面。默认的 `admin / admin` 更是几乎等于把后台敞开。
 * 这只是最轻的一层防护（内存计数、重启即失效），真正的兜底仍然是
 * 「去管理页把默认密码改掉」。
 */
config.loginFailMax = envInt('PK_LOGIN_FAIL_MAX', 20);
config.loginFailWindowMs = envInt('PK_LOGIN_FAIL_WINDOW_MS', 10 * 60 * 1000);

module.exports = { config, PK, DEFAULT_HOST, lanAddresses };
