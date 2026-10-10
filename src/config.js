'use strict';
/**
 * 全局配置与常量（只读环境变量；持久化数据在 SQLite）。
 */

const path = require('node:path');
const fs = require('node:fs');
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
   * 「版本号 → 签名资产」映射（**服务端实际规则**，2026-10-08 矩阵实验实测）。
   *
   * ## 为什么必须有这张表
   *
   * 服务端按 URL 里的 `version` 参数选择签名算法，**不是**按路径。
   * 版本与资产错配时一律 417（`x-block-by: solar-encoder`）。
   *
   * 实测矩阵（POST /leo-game-pk/android/math/pk/match/v2）：
   *
   *   | variant  | version | 结果                        |
   *   |----------|---------|-----------------------------|
   *   | pk       | 3.143.1 | 400（业务错）⇒ sign 通过 ✅ |
   *   | exercise | 3.141.1 | 400（业务错）⇒ sign 通过 ✅ |
   *   | pk       | 3.141.1 | 417 ❌                      |
   *   | exercise | 3.143.1 | 417 ❌                      |
   *
   * ## 历史教训
   *
   * 旧实现按**路径**判断（`/leo-game-pk` → pk 资产）。2026-10-08 把公共参数
   * 统一成真机的 `version=3.141.1` 后，PK 路径变成「3.141.1 + pk 资产」→
   * 错配 → PK 链路整体 417。改版本号必须同步改资产，靠人记变不可靠，
   * 故改为**由版本推导**。
   *
   * 约定：
   *   · 两者必须成对出现，改一个就要改另一个；
   *   · 未列出的版本回落 `exercise`（当前主力版本就是它）。
   */
  signVariantByVersion: {
    '3.140.1': 'exercise',
    '3.141.1': 'exercise',
    '3.143.1': 'pk',
  },
  /** 版本未知时的默认签名资产。 */
  defaultSignVariant: 'exercise',

  /**
   * 练习「提交节奏」—— 出题到提交之间要等多久。
   *
   * ## 背景（实测，2026-10-08）
   *
   * 服务端校验的是「提交时刻 − 出题时刻」的**实际间隔**，且**按题数放大**
   * （防机器秒答）。它与请求里声明的 `costTime` **完全无关**：
   *
   *     tools/probe-declared-vs-elapsed.js
   *       声明每题 5000ms、只等 1.1s → 400
   *       声明每题   1ms、真等 5.3s → 200     ← 声明小到 1ms 也照样过
   *
   * ## 两个实测系数（用户提供）
   *
   *   · **0.2s/题** —— 提交即可通过
   *   · **0.5s/题** —— 上榜所需（结算时间要卡到 0.5s/题）
   *
   * 我此前的梯度也印证了「下限随题数增长」（10 题 1.6s 败 / 2.0s 成；
   * 100 题 12s 败 / 30s 成），只是当时没拿到「上榜」这个额外维度。
   *
   * ⚠️ 注意：我曾误把等待写成「= 声明总耗时（900ms/题）」，导致 100 题
   *    干等 90s。那不是服务端要求，是我的误判，已纠正。
   */
  exerciseSubmitPace: {
    /**
     * 默认模式。用户要求「主打上榜」→ 默认 `rank`。
     * 可用 `PK_EX_SUBMIT_GAP_MODE=speed|rank` 覆盖。
     */
    defaultMode: process.env.PK_EX_SUBMIT_GAP_MODE || 'rush',

    /**
     * 两个模式（实测系数，2026-10-08）。
     *
     * `perQMs` = 每题的「出题→提交」间隔；`padMs` = 固定余量
     * （抵消网络往返与时钟偏差，避免刚好卡在阈值上被判不足）。
     *
     * | 模式 | 定位 | 单题 | 余量 | 说明 |
     * |---|---|---|---|---|
     * | `speed` | **刷分，主打速度** | 200ms | 300ms | 实测够过提交，最快 |
     * | `rank`  | **上榜，主打上榜** | 500ms | 500ms | 结算时间要卡到 0.5s/题 |
     */
    modes: {
      /**
       * **冲榜模式** —— 所有间隔压到实测最小。
       *
       * ## 实测依据（tools/calibrate-submit-min.js，10 题梯度）
       *
       *   300ms(30ms/题)  → 400
       *   1754ms(175ms/题)→ 400
       *   2473ms(247ms/题)→ ✅ 200
       *   2602ms(260ms/题)→ ✅ 200
       *
       * ⇒ 单题下限约 **200~260ms**。
       *
       * `perQMs`（每题 costTime）仍保持 500ms —— 已确认服务端**不校验**每题之和
       * （tools/probe-top-vs-perq.js），保留它可维持「上榜速度」资格；
       * 真正决定等待的是 `basePerQMs`（顶层），压到 200ms/题。
       */
      rush: { perQMs: 500, basePerQMs: 250, padMs: 300, label: '冲榜模式（间隔最小）' },

      /** 刷分：速度优先，但不追最小。 */
      speed: { perQMs: 200, basePerQMs: 200, padMs: 300, label: '刷分模式（速度优先）' },

      /** 上榜：结算时间卡到 0.5s/题。 */
      rank: { perQMs: 500, basePerQMs: 200, padMs: 500, label: '上榜模式' },
    },
    /** 旧字段兼容：无模式信息时的兜底余量。 */
    fixedPadMs: 500,
  },

  /**
   * 练习吞吐相关的提速参数。
   *
   * ## 瓶颈在哪（实测）
   *
   *   tools/measure-match-cooldown.js：出题冷却约 **58 秒**（服务端硬约束），
   *   而提交只要约 2 秒 —— 一局里 56 秒空闲。
   *   ⇒ 提速不能靠「调短提交等待」，要靠下面三项。
   */
  exerciseSpeed: {
    /**
     * 撞 429 后的重试轮询间隔（毫秒）。
     *
     * 旧值写死 10000（10s），而 `MATCH_COOLDOWN_MS` 是 1500（1.5s）——
     * 两者自相矛盾，导致每轮平均白等约 4~5s。
     * 改成 3000 后，最坏也只多等 3s。可用 PK_EX_MATCH_RETRY_MS 覆盖。
     */
    matchRetryMs: process.env.PK_EX_MATCH_RETRY_MS || 3000,

    /**
     * 默认每局题数。**这是最有效的提速杠杆**：
     * 同一个 58s 冷却窗口里，100 题拿 200 经验、200 题拿 400 经验。
     * 可用 PK_EX_DEFAULT_LIMIT 覆盖。
     */
    defaultLimit: process.env.PK_EX_DEFAULT_LIMIT || 200,

    /** 口算每局可选的最大题数（服务端上限，超出会被拒）。 */
    maxLimit: 200,

    /**
     * 出题 429 后的轮询间隔（毫秒）——**冲榜模式压到最小**。
     *
     * 为什么能这么小：不需要「提前等够冷却」，而是**贴着窗口轮询抢**，
     * 一放行立刻发车。实测（tools/recheck-cooldown.js）冷却是每账号独立的
     * 硬约束，抢反而比等更快、更准。
     */
    rushRetryMs: process.env.PK_EX_RUSH_RETRY_MS || 400,
  },

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

  /**
   * cloudflared 可执行文件路径。
   *
   * # 为什么要有两个候选（Android 特有）
   *
   * Android 10+ 的 **W^X + SELinux** 下，App 私有目录（`files/`）里的文件
   * 标签是 `app_data_file` —— **App 自己的进程不能执行它**。
   * 真机实测：`spawn .../files/pk-node/bin/cloudflared → EACCES`；
   * 用 `runcon u:r:untrusted_app` 直接验证也是 Permission denied。
   *
   * 而 APK 的 `nativeLibraryDir`（`/data/app/.../lib/arm64`）标签是
   * `apk_data_file` —— **可执行**。内置 node 就是这么跑起来的（`libnode.so`）。
   *
   * 所以 App 把 cloudflared 打包成 `jniLibs/arm64-v8a/libcloudflared.so`，
   * 安装器会把它解压到 nativeLibraryDir（由 App 通过 PK_NATIVE_LIB_DIR 告知），
   * 这里优先用它。找不到才回落到开发环境用的 `bin/cloudflared`。
   *
   * 优先级：`PK_CLOUDFLARED` 环境变量 > nativeLibraryDir > `bin/cloudflared`。
   */
  cloudflaredPath: resolveCloudflaredPath(),
};

/** 是否监听在「所有网卡」= 局域网/公网能访问。用于启动横幅提示与登录限流强度。 */
config.isExposed = (config.host === '0.0.0.0' || config.host === '::' || config.host === '');

/**
 * 关键常量：PK 协议。
 * 全部来自 cn.apixiaoyuan.app 的实测/逆向结论，**不要凭猜改**。
 */
const PK = {
  /**
   * 公共参数 —— **2026-10-08 真机实测逐字**（App 原生日志 353 个请求）。
   *
   * 真机所有服务（leo-star / leo-math / leo-game-pk / leo-profile / solar-activity …）
   * 用的是**同一套**参数，不存在「主域一套、练习一套」：
   *
   *   platform=android37  version=3.141.1  vendor=UC  av=5
   *   deviceCategory=phone  webviewVersion=150  whRatio=2.17
   *
   * 旧代码把参数拆成 MAIN_COMMON_QUERY(3.140.1/android37) 与
   * COMMON_QUERY(3.143.1/android35/fenbi/110/1.78) 两套，两套**都错**：
   *   · 3.140.1 落后（服务端已放行 3.141.1）
   *   · 3.143.1 超前（真机根本没有这个版本）
   *   · android35 / fenbi / 110 / 1.78 与真机逐字值均不符
   * 参数对不上会被 solar-encoder 判异构 → 400 / 417。
   */
  commonQuery: {
    platform: 'android37',
    version: '3.141.1',
    vendor: 'UC',
    av: '5',
    deviceCategory: 'phone',
    webviewVersion: '150',
    whRatio: '2.17',
  },

  /** 旧字段保留（外部可能引用），值已对齐真机。 */
  exercise: {
    platform: 'android37',
    version: '3.141.1',
    vendor: 'UC',
    av: '5',
    deviceCategory: 'phone',
    webviewVersion: '150',
    whRatio: '2.17',
    isBackground: '0',
    productId: '611',
  },

  /**
   * 产品线 id。真机实测：**所有服务一律 611**（356 次请求无一例外）。
   */
  productIdDefault: '611',
  productIdPk: '611',

  /** 风控头（真机逐字）。 */
  headers: {
    'X-XYKS-REQ-NETWORK-ENV': 'mobile',
    'x-shepherd-sessionid': '0',
  },

  /**
   * 提交接口独立频控：默认等 10s、最多 2 次。
   */
  rateLimitBaseMs: 10_000,
  rateLimitMaxWait: 2,
  /**
   * 出题接口冷却：本轮真机日志未观察到 60s 频控（366 个请求全 200）。
   * 如需恢复限速：PK_MATCH_COOLDOWN_MS=61600。
   */
  matchCooldownMs: envInt('PK_MATCH_COOLDOWN_MS', 0),
  /** 出题撞 400/403 时的重试间隔。 */
  matchRetryIntervalMs: 10_000,
  /** 出题重试的累计上限（超此才判该轮失败）。 */
  matchRetryMaxMs: 120_000,
  /** 冷却估计最多往回缩这么多。 */
  matchCooldownSafetyMs: 0,

  /**
   * 真机 UA 模板：`Leo/<version> (<BRAND><MODEL>; Android <sdk>; Scale/<scale>)`
   * 真机逐字：`Leo/3.141.1 (Redmi25053RT47C; Android 17; Scale/3.25)`
   */
  uaTemplate: (ver, brand, model, sdk, scale) =>
    'Leo/' + ver + ' (' + brand + model + '; Android ' + sdk + '; Scale/' + scale + ')',
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

/**
 * 「App 联动」共享令牌（★ 2026-10-03）。
 *
 * ## 作用
 *
 * 老挂 App 内置了本服务（跑在 127.0.0.1），需要：
 *   1. 自动用**管理员账号**登录（免手输 admin/admin）；
 *   2. 把服务里已登录的**小猿账号**导入 App（给 PK H5 用）。
 *
 * 这两件事都要求接口能**拿到明文凭据**，而正常接口是刻意不回的
 * （`publicLeoAccount` 只回 cookie 名字，不回值）。
 *
 * ## 为什么要令牌
 *
 * 本服务默认监听 `0.0.0.0`（局域网/公网可达）。上面那两个接口一旦裸奔，
 * 等于把登录态白送出去。所以：
 *   - 只在请求头 `X-PK-Link` 等于本令牌时才放行；
 *   - 令牌**默认随机生成**（每次启动变），只写在 App 私有目录里；
 *   - 想固定可设 `PK_LINK_TOKEN=<值>`（例如容器化部署时）。
 *
 * 随机生成用 `crypto.randomBytes`（Node 内置，无需额外依赖）。
 */
config.linkToken = process.env.PK_LINK_TOKEN || require('node:crypto').randomBytes(24).toString('hex');

/** 是否是「随机生成」的令牌（用于启动横幅提示怎么取）。 */
config.linkTokenIsRandom = !process.env.PK_LINK_TOKEN;

module.exports = { config, PK, DEFAULT_HOST, lanAddresses };

/**
 * 按优先级挑一个 cloudflared 路径。
 *
 * 注意：这里只挑「首选路径」，**是否存在由 tunnel.js 的 available() 判断**
 * （那里还会兜底查 PATH，并给出下载提示）。
 */
function resolveCloudflaredPath() {
  if (process.env.PK_CLOUDFLARED) return process.env.PK_CLOUDFLARED;
  const nativeDir = process.env.PK_NATIVE_LIB_DIR;
  if (nativeDir) {
    const p = path.join(nativeDir, 'libcloudflared.so');
    if (fs.existsSync(p)) return p;
  }
  return path.join(ROOT, 'bin', 'cloudflared');
}
