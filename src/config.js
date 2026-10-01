'use strict';
/**
 * 全局配置与常量。
 *
 * 只读环境变量，不读配置文件 —— 便于「一个命令起服务」。
 * 需要持久化的东西（用户、子账号、任务、设置）都在 SQLite 里。
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function envInt(name, def) {
  const v = process.env[name];
  const n = v == null ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const config = {
  root: ROOT,
  /** 监听地址。默认只监听回环（用户要求 127.0.0.1）；内网/穿透时用 0.0.0.0。 */
  host: process.env.PK_HOST || '127.0.0.1',
  // ★ 2026-09-30：本机 8791 已被 MT APK MCP 占用（用户决定 MCP 留 8791），
  //   pk-node 固定用 8792，避免每次都要带 PK_PORT= 环境变量。
  //   仍可用 PK_PORT 覆盖。
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
   *   ro.product.brand=Redmi, ro.product.model=25053RT47C,
   *   ro.build.version.sdk=37, ro.sf.lcd_density=520 → Scale 3.25
   * 拼出来正是 `Leo/3.141.1 (Redmi25053RT47C; Android 17; Scale/3.25)`，
   * 与「老挂戏老叟」抓到的宿主 200 请求 UA 逐字一致。
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
     * 而原版 UA 写的是 `Android 17`（实测抓包逐字）。两个值必须都按原版来，
     * 不然风控会把请求判成异构（练习端点实测 417）。
     */
    uaSdk: envInt('PK_DEVICE_UA_SDK', 17),
    scale: process.env.PK_DEVICE_SCALE || '3.25',
  },

  /**
   * 是否给主域请求加 `sign`。
   *
   * - `off`  —— 不加（**默认**）
   * - `auto` —— 能算就算（需要 arm64 原生库），算不了就不加
   * - `on`   —— 必须加，算不出来就抛错
   *
   * ## 为什么默认 `off`（2026-09-27 实测）
   *
   * PK 的 `home` / `match` / `submit` 三个端点**都不需要 sign**：
   * 不带 sign 时 `match` 与 `submit` 均实测返回 **HTTP 200**（提交成功）；
   * 反而带上 sign 时遇到过 403。而那批「必须带 sign」的主域端点
   * （`accounts/switch` / `batchGet`）**带了也照样 417** —— 它们的拦截
   * 与 sign 无关（见 README 的 417 说明）。
   *
   * 结论：sign 对当前的可用端点没有任何增益，却在 arm64 上才跑得动。
   * 关掉它 → **x86 / Windows 也能完整刷局**（内容编码已是纯 JS）。
   *
   * 若将来确认某端点确实需要 sign，把它设为 `on` 并保留 `bin/native/` 即可。
   */
  /**
   * sign 模式：`auto`（默认）/ `on` / `off`。
   *
   * ★ 2026-09-28 修正：原以为「PK 不需要 sign」，实际 **提交/switch/batchGet 都需要**，
   * 只是 PK 的 home/match 恰好放行。所以默认改成 `auto`：
   *   - 有 arm64 native（bin/native/lre.so）→ 自动算 sign；
   *   - 没有（Windows/x86）→ 静默不加，PK 出题仍可用，但 submit/switch 会 417。
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

/**
 * 关键常量：PK 协议。
 * 全部来自 cn.apixiaoyuan.app 的实测/逆向结论，**不要凭猜改**。
 */
const PK = {
  /** 主域公共参数（缺 sign 会 417；PK 还要额外 _appId / _productId=631）。 */
  commonQuery: {
    platform: 'android36',
    version: '3.141.1',
    vendor: 'UC',
    av: '5',
    deviceCategory: 'phone',
    webviewVersion: '150',
    whRatio: '2.17',
    isBackground: '0',
  },
  /** 练习/普通主域端点用 611；PK 端点用 631 + _appId=6。 */
  productIdDefault: '611',
  productIdPk: '631',
  appIdPk: '6',

  /**
   * 练习（`/leo-star` `/leo-math` `/leo-reward` 主域端点）的公共参数。
   *
   * ## ★ 为什么单独一套（2026-09-28 实测，417 墙的根因）
   *
   * 主域端点被 `solar-encoder` 拦成 417，**根因是 `version`**：
   * 拿原版真实抓包（`auto_oral-2026-09-27.log`）逐行对比后逐项 A/B：
   *
   * ```
   * 417   platform=android36 + version=3.141.1   ← 我们原来的值
   * 417   + platform=android37
   * 200   + version=3.140.1                    ← 改这一个就通
   * ```
   *
   * 注意：App 包名版本是 3.141.1，但**服务端放行的是 3.140.1**
   * —— 未知版本号直接被判可疑。所以练习一律用 `3.140.1` + `android37`。
   *
   * PK 端点（`leo-game-pk`）**不受此限**（它走另一套校验，且不需要 sign），
   * 所以 PK 仍沿用 [PK.commonQuery]，两边互不影响。
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
   * 提交接口独立频控：窗口约十分钟级，默认等 60s/120s，最多 2 次。
   *
   * 注：设备参数（UA）与 `x-shepherd-did` 属于**设备级凭据**，
   * 不在本对象里 —— 见 [config.device] / [config.shepherdDid]。
   */
  rateLimitBaseMs: 60_000,
  rateLimitMaxWait: 2,
  /**
 * 出题接口的冷却（**历史值：2026-09-27 实测 ≈ 61.6 秒**，同账号）。
 *
 * ⚠️ 本节末尾有 2026-10-01 的**复测修正**：
 * 该冷却**仍然存在**（约 60 秒），但引擎被改成**不强制**等它 —— 默认值 0，
 * 节奏交给用户在网页上填的「每轮间隔」（网页默认填 60000/65000 并给出提示）。
 *
 * 实测方法：先成功出题一次，然后每 10s 试一次，直到再次 200 →
 * 10/21/31/41/51s 全 400，62s 放行。
 *
 * ## 这个数字有多「硬」？（都试过，全部 400）
 *
 * | 变体 | 结果 |
 * |---|---|
 * | 换知识点 `pointId` | 400 |
 * | 换 UA（`Leo/…` ↔ 真实 WebView UA） | 400 |
 * | 换 `platform`（`android36` ↔ `browser`） | 400 |
 * | 加 / 不加减 `sign` | 400 |
 * | 删风控头 / 加 `sw8` / 加主域头 | 400 |
 * | 补 App 注入的参数（`YFD_U` / `from` / `phaseId` / `vendor`） | 400 |
 * | 换其它出题接口（`multi/match` / `english/pk/match`） | 400 |
 *
 * ⇒ 冷却是**账号级**的，与请求形态无关。原版走 `match/v2`（需要 App 的
 * LeoSecure 原生桥，纯 HTTP 9 种组合一律 417），所以本方案下
 * **「每账号 ≈ 60s 一局」就是硬上限**。
 *
 * ## ★★ 2026-10-01 复测**修正**：冷却并没有消失，只是引擎不再「强制」等它
 *
 * 早先一次复测（同账号连续出题、间隔 1.5s，4 次全 200）被当成了
 * 「服务端已放开」。**后续实测推翻了这个结论：≈60 秒级的账号级出题冷却依然在**
 * （窗口内偶发放行会让人误判）。
 *
 * 所以现在的产品口径是「**提示 + 建议**，但**不强制**」：
 *
 *   · 引擎侧：本字段默认 **0** —— 不再硬编码等待，节奏完全交给用户在网页上
 *     填的「每轮最小/最大间隔」；
 *   · 网页侧：把默认值填成 **60000 / 65000**，并写明「服务端有约 60 秒冷却，
 *     建议设 60 秒」，另配一个「填入推荐值」按钮；用户要设别的数也由他去；
 *   · 兜底：撞到 400/403 仍按 [matchRetryIntervalMs] 重试（累计超
 *     [matchRetryMaxMs] 才判这轮失败）—— 所以把间隔设小了也不会整轮白跑，
 *     只是等待会挪到重试里、日志多几行。
 *
 * 若想让引擎**自动**贴着冷却下沿跑（不依赖用户填数），设
 * `PK_MATCH_COOLDOWN_MS=61600` 即可恢复旧行为。
 *
 * ⚠️ **练习链路没有这个冷却**（见 `src/exercise.js` 的 `MATCH_COOLDOWN_MS` = 1.5s，
 * 实测连续出题全 200），两边的结论**不要互相套用**。
 */
matchCooldownMs: envInt('PK_MATCH_COOLDOWN_MS', 0),
/** 撞到出题频控（400/403）时的兜底重试间隔 / 累计上限。 */
matchRetryIntervalMs: 3_000,
/**
 * 出题重试的**累计上限**（判该轮失败前最多等多久）。
 *
 * ⚠️ 保持 4 分钟而不是缩短：实测（任务 #35）「间隔设成 4~8s、重试 8s」时，
 * 连续重试到 121s **仍然没放行**（撞上更长的惩罚窗口）→ 上限太短会让整轮直接判失败。
 * 给足时间，用户把间隔设小了也大概率能蹲到放行。
 */
matchRetryMaxMs: 240_000,
/** 冷却的估计最多往回缩这么多（避免每次都在窗口边缘白撞一次）。 */
matchCooldownSafetyMs: 0,
};

/**
 * 最大并行任务数（**任务之间**并行；每个任务内部仍串行）。
 *
 * ★ 2026-10-01：默认改为 **0 = 不限制**（用户要求解除「最多 3 个」的限制）。
 *
 * 为什么敢不限：任务内部本来就是逐轮串行，且出题/提交各自都有频控退避
 * （撞到 400/403 会自动退避重试）。并行多了只会各自慢一点，不会互相打死。
 * 仍可用环境变量 `PK_MAX_CONCURRENT` 设一个正整数来限制。
 */
config.maxConcurrentJobs = envInt('PK_MAX_CONCURRENT', 0);

module.exports = { config, PK };
