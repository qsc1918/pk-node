# pk-node · 小猿口算 刷局 / 刷练习（网页版本地服务）

---

> ## ⚠️ 免责声明（请先读这一段）
>
> **本项目仅供学习与技术交流使用。**
>
> - **严禁**用于任何商业用途、批量刷分、代练、破坏平台正常运营，或任何违反服务条款与法律法规的行为。
> - 使用者须自行承担**全部风险与法律责任**；作者不对任何直接或间接后果负责。
> - 本项目与「小猿口算」及其运营方**无任何关联**，未获其授权或认可。
> - 仓库内涉及的商标、App 名称、第三方二进制，版权均归各自权利人所有。
> - **如有侵权，请通过 Issues 或邮箱告知，将在收到通知后立即删除相关内容。**
>
> 继续阅读或使用，即表示你已理解并同意上述条款。完整版见文末
> [「免责声明（完整版）」](#免责声明完整版) 与 [DISCLAIMER.md](DISCLAIMER.md)。

---


一个**零外部依赖**的本地 Node 服务：起个网页，导入小猿登录态 → 选子账号 → 刷 PK 对局，
带 SQLite 本地库、实时日志（SSE）、管理后台，并可选 Cloudflare 临时内网穿透。

MIT License —— `bin/native/` 下的第三方二进制不在授权范围内，见 [NOTICE](bin/native/NOTICE.md)

[![selftest](https://github.com/sxd91/pk-node/actions/workflows/selftest.yml/badge.svg)](https://github.com/sxd91/pk-node/actions/workflows/selftest.yml)
[![pages](https://github.com/sxd91/pk-node/actions/workflows/pages.yml/badge.svg)](https://sxd91.github.io/pk-node/)

📄 **项目介绍页：https://sxd91.github.io/pk-node/**

## 下载 / 运行

| 方式 | 说明 |
|---|---|
| **[免安装包（Releases）](https://github.com/sxd91/pk-node/releases/latest)** | 解压即用，**推荐**。含密钥流 + 全部源码，不用 `npm install` |
| `git clone` 源码 | 在项目根运行下面的命令 |

只要求 **Node.js ≥ 22**（用到内置 `node:sqlite`），除此之外零依赖。

```bash
./start.sh                 # 默认 http://127.0.0.1:8787
PK_PORT=8790 ./start.sh    # 换端口
```

Windows：双击 `start.bat` —— **可完整刷局 + 刷练习**（内容编码是纯 JS；`sign` 也已改成纯 JS 模拟 arm64 机器码，不再需要 WSL / arm64）

浏览器打开 → 用 `admin / admin` 登录（**第一次登录后请立刻改密**）。

---
## 🚀 使用教程（快速上手）

> 完整说明见 [第五节 使用流程](#五使用流程)；这里是最短路径。

### 第 1 步 · 启动服务
```bash
git clone https://github.com/sxd91/pk-node.git && cd pk-node
./start.sh                     # Windows：双击 start.bat
# 默认 http://127.0.0.1:8787
```
或直接下 [免安装包](https://github.com/sxd91/pk-node/releases/latest) 解压运行（**推荐**，免 `npm install`）。
需要 **Node.js ≥ 22**（用到内置 `node:sqlite`），除此之外**零依赖**。

### 第 2 步 · 登录后台
浏览器打开 `http://127.0.0.1:8787` → `admin / admin` → **立刻改密**（「管理」页可改）。

### 第 3 步 · 导入小猿账号
「小猿账号」页任选一种（效果一致）：
| 方式 | 操作 |
|---|---|
| **短信验证码**（推荐） | 填手机号 → 发送验证码 → 填验证码 → 登录 |
| **密码登录** | 手机号 + 密码（密码 RSA 加密后提交，本地不留明文） |
| **粘贴 Cookie** | 从已登录环境导出，**必须含 `sess`**、域 `.yuanfudao.com` |

### 第 4 步 · 刷练习（推荐）或 刷 PK
| 玩法 | 入口 | 说明 |
|---|---|---|
| **刷练习** ⭐ | 「刷练习」tab → 选账号 / 知识点 / `limit` / 轮数 → 开始 | 出题→抄答案→提交**全自动闭环**。经验 = 答对题数 × 2（**100 题 = 200 经验**）。出题冷却 ≈62 秒/账号，引擎**自动配速**、撞频控自动重试 |
| 刷 PK 对局 | 「刷局」tab → 选子账号 / 知识点 / 局数 → 开始 | 右侧 SSE 实时日志；「任务」页可查逐轮明细 |

### 第 5 步 · 看结果
- 「刷练习」/「刷局」页的**实时日志**逐轮显示：出题 → 提交 → 服务端判对 X/Y → 经验 +N。
- 分数以**服务端 `curWeekScore` 为准**（「刷新分数/任务」按钮可随时读）。

### 命令行等价操作
```bash
node bin/selftest.js          # 自检（native / sign / RSA / 笔画 / 编码器）
node bin/reset-admin.js 新密码 # 重置管理员密码
sh bin/get-cloudflared.sh      # 下载穿透客户端（可选）
```

---

## 一、它做了什么

| 模块 | 说明 |
|---|---|
| 本服务账号 | 注册 / 登录 / 会话（`scrypt` 哈希 + HttpOnly cookie）。默认管理员 `admin/admin`。 |
| 小猿账号 | **三条入口**：短信验证码登录 / 密码登录 / 粘贴 cookie。导入即自动探活 + 拉子账号；可切号。 |
| 刷局 | 出题 → 组 body → 加密 → 提交，逐轮落库；支持局数 / 知识点 / 间隔 / 频控退避。 |
| 实时日志 | SSE 推送每一轮进度到网页；断线可刷新页面看任务明细。 |
| 本地 DB | Node 内置 `node:sqlite`（**不需要 npm install**）。 |
| 管理后台 | 用户管理（新增/重置密/禁用）、全部任务、审计日志、系统自检。 |
| 穿透 | `cloudflared` 快速隧道 → `*.trycloudflare.com`（免账号，进程停即失效）。 |

---

## 二、原生依赖：**已全部解除**

小猿的两个关键环节原本都是 **arm64 原生实现**。两者都已解决，
**现在不需要 `bin/native/` 里的任何 arm64 库，Windows 也能完整刷局**：

1. **内容编码器** —— ✅ **已用纯 JS 复现，不再需要原生库**。
   差分分析证明 `libContentEncoder.so` 的内层函数 `c()` 就是
   **「与一条固定密钥流逐位置 XOR」**：

   | 实验 | 结果 |
   |---|---|
   | 翻转输入 1 bit | 输出**只变同位置 1 个字节**（无扩散） |
   | 两段不同的同长输入 | `in XOR out` 得到的流**完全相同** |
   | 短输入 vs 长输入前缀 | 密钥流**逐字节一致**（与总长无关） |
   | 同输入重复编码 | 完全一致（确定性） |

   ⇒ `out[i] = in[i] ^ K[i]`，于是**编码全零输入，输出就是密钥流**。
   密钥流已提取为 `bin/keystream.bin`（128 KiB），纯 JS XOR 在
   1B / 2B / 17B / 256B / 4524B / 20000B / 131071B / 131072B **全部逐字节等于原生结果**，
   并且**与真机抓包密文一致**。收益：x86/Windows 也能编码，且省掉每轮 80–250ms 的子进程开销
   （实测降到 ~14ms）。

2. **`sign`** —— ✅ **已改为纯 JS 复刻**（2026-10-01，PR #1）。

   `sign` 的 `T` 段原先只能靠 `bin/native/linker64 + dump7` 执行 `lre.so` 里那段
   arm64 机器码取得，**Windows / x86 / 非 arm64 上算不出来** —— `calcSign` 一失败，
   `maybeSign()` 就静默不带 `sign`，**练习端点必然 417 `x-block-by: solar-encoder`**
   （这就是「PK 能用、练习不能用」的真正根因）。

   现由 `src/lre-emu.js` 用 JS **逐条解释执行同一段机器码**算出 T
   （指令表 `src/lre-insns.js`，由 `tools/gen-lre-insns.py` 用 capstone 离线生成），
   平台无关、零外部依赖。判据：真机抓包 fixture 在该分钟的输出 **逐字节一致（410/410）**，
   自检里跑 `node tools/sign-selftest.js` 即可验证。

   > 说明：`T` 是 base-100 大数的十进制展开、随分钟变化且无闭式，所以**不能「推导」**；
   > 但可以「**执行**」—— 模拟器做的就是执行原机器码本身，因此结果与真机等同。
   >
   > `PK_SIGN_MODE` 默认 `auto`：练习端点一律带 sign；PK 端点按需。

### 原生库还需要吗

**不需要 `linker64` / `dump7` / `libc*` / `libContentEncoder*` 这些可执行资产了**（内容编码
纯 JS、sign 纯 JS 模拟）。**唯一保留的是 `bin/native/lre.so`（0.9MB）** —— 它不再被
*执行*，而是作为**数据**：`src/lre-emu.js` 从里面读机器码字节与常量表。发布包里已含它。

### 跑 Android so 的做法

在 proot 里用 Android 自己的 linker：

```bash
LD_LIBRARY_PATH=bin/native bin/native/linker64 bin/native/enc_device <so> <in> <out>
```

`bin/native/` 里必须有：`linker64`、`libc.so`、`libm.so`、`libdl.so`、`liblog.so`、
`libc++.so`、`libc++_shared.so`、`libContentEncoder_patched.so`、`lre.so`、`dump7`、`enc_device`。

> **内容编码不再需要这些** —— 它走 `bin/keystream.bin`（纯 JS XOR）。
> 上面这些只为 `sign` 保留。密钥流换版本时用 `node tools/keystream-extract.js` 重新提取。

> ⚠️ `libContentEncoder_patched.so` 是把 `DT_NEEDED: libandroid.so` **等长覆盖**成 `libc.so`
> 的版本 —— 因为 libandroid 会拖出一长串 proot 里拉不起来的系统依赖。

自检（不开服务也能跑）：

```bash
node bin/selftest.js
# 或 npm run selftest
```

---

## 三、目录结构

```
pk-node/
├── server.js               # HTTP 服务 + 路由（零依赖）
├── start.sh                # 启动脚本（校验 Node 版本 + 打印 native 资产）
├── package.json
├── src/
│   ├── config.js           # 配置与 PK 协议常量（公共参数、频控参数）
│   ├── db.js               # SQLite 层（建表 + 全部查询；含默认管理员种子）
│   ├── http.js             # 极简 HTTP 客户端 + CookieJar（正确处理前导点域）
│   ├── crypto-rsa.js       # RSA 编码（手机号/验证码/密码）+ 格式校验
│   ├── sign.js             # sign 公式（纯 JS + 离线自校验样本）
│   ├── native.js           # 调 linker64 跑 so：sign / 内容编码 / gzip 对齐
│   ├── strokes.js          # 画笔算法：ARC 弧线 / SEVEN_SEGMENT 七段码
│   ├── leo.js              # 小猿协议层：URL 组装（公共参数 + sign）、PK / 账号 / 子账号接口
│   ├── pk-engine.js        # 出题 → 组装 body → 加密 → 提交 → 频控退避
│   ├── jobs.js             # 任务调度（串行 + 停止 + SSE 事件缓冲）
│   ├── tunnel.js           # cloudflared 快速隧道封装
│   └── services/
│       ├── auth.js         # 本服务账号
│       ├── login.js        # 小猿登录（短信 / 密码）
│       └── leo-accounts.js # 小猿账号导入 / 刷新 / 切号
├── public/                 # 网页（原生 HTML+JS+CSS，无构建）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── bin/
│   ├── native/             # 原生资产（见上）
│   ├── selftest.js         # 命令行自检
│   ├── pick-port.js        # 挑空闲端口（start.sh 用）
│   ├── reset-admin.js      # 忘记密码时重置管理员
│   └── get-cloudflared.sh  # 下载穿透客户端
└── data/pk-node.sqlite     # 运行时生成
```

---

## 四、关键协议（改代码前必读）

### 1. 公共参数必须「逐参数补齐」

PK 端点要 `_productId=631&_appId=6`，其它主域端点要 `_productId=611`。
调用方显式给的值**必须原样保留**，缺的才补 —— 整体覆盖会把 631 冲成 611，PK 直接
401（SolarAuthFilter）。

### 2. sign 的输入是 `encodedPath`（不含 query）

```
s1 = path + salt                    d1 = md5(s1)
s2 = s1 + d1 + path                 d2 = md5(s2)
s3 = s2 + d2 + T                    d3 = md5(s3)
sign = md5(s3 + d3 + salt)          salt = "wdi4n2t8edr"
```

### 3. 提交 body 结构（真机 ground truth，**不要加字段**）

顶层展开 examVO 字段，**没有** `examVO` 嵌套、**没有** `userInfos`、**没有** `updatedTime`
（加上去会 400）：

```json
{"pkIdStr":"…","pointId":1951,"pointName":"5以内比大小","ruleType":-7,
 "questionCnt":20,"correctCnt":20,"costTime":8000,
 "questions":[{"id":…,"examId":…,"content":…,"answer":…,"userAnswer":…,"answers":[…],
   "status":1,"script":"…","wrongScript":null,"ruleType":"COMPARE","errorState":0,
   "curTrueAnswer":{"recognizeResult":"…","pathPoints":[…],"answer":1,"showReductionFraction":0}}]}
```

- `script` = `JSON.stringify(pathPoints)`，两处**同源**。
- 笔迹是**画布像素坐标**（x≈150–240，y≈450–500），比较题用密集弧线模板（`<` 左弧 / `>` 右弧）。

### 4. 提交接口有**独立频控**（403，窗口约十分钟级）

因此本项目**串行**跑任务，且默认 `60s / 120s` 大退避、最多 2 次（可在网页高级参数里改）。
并发提交只会把请求一起打进频控窗口。

### 4.2 出题接口的冷却：**≈ 61.6 秒，按账号**（2026-09-27 实测）

这是本项目最反直觉、也最容易踩的一点：

```
① math/pk/match?pointId=16   → 200（冷却起点）
② 立刻换 pointId=17（另一个知识点） → 400「请求过于频繁」
③ 立刻再打 pointId=16            → 400「请求过于频繁」
```

以下都**试过且全部无效**（说明不是请求指纹问题）：

| 尝试 | 结果 |
|---|---|
| 换知识点 `pointId` | 400 |
| 换 `User-Agent`（Leo/… ↔ WebView 真实 UA） | 400 |
| 换 `platform`（`android36` ↔ `browser`） | 400 |
| 加 / 不加 `sign` | 400 |
| 删风控头（`X-XYKS-*` / `x-shepherd-sessionid`） | 400 |
| 换其它出题接口（`multi/match` / `english/pk/match`） | 400 |

⇒ **冷却是账号级、跨知识点、跨出题接口共享的。**

**原版为什么快？** 原版走 `math/pk/match/v2`（返回 arraybuffer 加密体）。
`/v2` 需要 App 内 WebView 原生桥（`LeoSecure.requestConfig`）参与，纯 Node 请求
在 9 种头/参数组合下**一律 417**。

**本项目的处理：贴着冷却下沿的闭环（这是「最快」的实现方式）**

不要去猜窗口大小，也不要靠调大轮间隔 —— 正确做法是**闭环**：

```
下一轮等待 = max(配置的轮间隔下限, 上次成功出题时刻 + 冷却 − 现在)
```

- 引擎记住**该账号**上次成功出题的时刻（按 `leoAccountId` 存在进程内，跨任务共享）；
- 到点前不浪费请求，到点后立刻发车 —— 每一轮都恰好卡在窗口开启的瞬间；
- 万一估计偏了（撞到 400），按 `出题频控重试间隔` 兜底重试，
  累计超 `出题最长等待` 才判该轮失败，所以**不会整轮白跑**。

实测（真实 HTTP API 跑 3 轮，`pointId=16`）：

```
第1轮 OK  提交成功并已结算（对 30 题）
第2轮 OK  距上轮 67.2s
第3轮 OK  距上轮 67.3s
平均每轮 67.2s  ← 冷却 61.6s + 提交/结算 ~5.6s，等于理论下限
3/3 全成功，0 次白撞
```

> 如实说明：**「每账号 ≈60s 一局」就是硬上限**。原版之所以能秒开下一局，
> 是因为它走 `match/v2`（需要 App 的 LeoSecure 原生桥，纯 HTTP 一律 417）。
> 想再快只有**加账号** —— 冷却按账号隔离，多号并行近似线性提速。

### 4.5 出题 → 提交 → **结算核对**（对齐真机结算页）

真机点了「继续PK」会打开
`result.html?pkIdStr=<pkIdStr>#/结算页面`，这个页面的数据源是：

```
GET /leo-game-pk/{client}/math/pk/history/detail?pkIdStr=<pkIdStr>
```

**关键：`submit` 返回 200 只代表服务端「收下了」，不代表这局已结算。** 实测两种历史记录：

| 情况 | `history/detail` 返回 |
|---|---|
| 提交成功 | `{correctCnt:20, questions:[…20 条明细…]}` |
| 提交被 403（没算上） | `{correctCnt:0, questions:null}` ← 服务端仍留占位记录 |

所以引擎在每次 `submit` 之后**都会再拉一次本接口核对**，日志里表现为：

```
[submit]     提交（第 1 次）→ 200
[settle-ok]  已结算：答对 20 题 / 明细 20 题      ← 这局真算上了
[settle-fail] 服务端未结算（correctCnt=0）—— 这局没算上   ← 会记为该轮失败
```

只读接口、**不计入出题频控**，每轮都调不影响刷局节奏。
（完整 API 面另见 `exercise-legacy` bundle：`math/pk/match[/v2]`、`math/pk/multi/match[/v2]`、
`final/pk/match/{math,english}/v2`、`english/pk/match[/v2]`、`word/eliminate/match[/v2]`、
`math/pk/submit`、`math/pk/multi/submit`、`final/pk/submit/{math,english}`、
`english/pk/submit`、`word/eliminate/submit`、`math/pk/reward/claim`、`pk/pros/use`、
`pk/login/sync`。`/v2` 系列返回 **arraybuffer 加密体**，本项目走旧版明文接口。）

### 4.7 练习链路（`/leo-star` / `/leo-math`）—— **417 已破**

与 PK 是**两条独立链路**。主域端点被 `solar-encoder` 拦成 417，根因只有一个：

```
version=3.141.1  → 417        version=3.140.1  → 200   ← 服务端拒绝未知版本号
platform=android36 → 417      platform=android37 → 200
```

另外两处也要对齐原版（拿真机抓包 `auto_oral-2026-09-27.log` 逐行比出来的）：

| 项 | 值 | 说明 |
|---|---|---|
| 请求头 | `leo-client-trace-id` + `default-namespace-sw8` | 主域风控会看 |
| UA | `Leo/3.140.1 (...; Android 17; ...)` | **是 17 不是 37**（37 是 query 的 `platform`） |
| `sign` | **必须带** | 不带就 417；与 PK 相反（PK 不需要） |

> ★ **2026-10-01：sign 已改为纯 JS 复刻，x86 / Windows 也能跑练习了。**
>
> 原先 `sign` 靠 `bin/native/linker64 + dump7` 执行 `lre.so` 里那段混淆代码取 T ——
> **那是 arm64 ELF，Windows/x86 上跑不起来**，`calcSign` 一失败，`maybeSign()`
> 就静默不带 `sign`，练习端点必然 **417 `x-block-by: solar-encoder`**。
> 这就是「PK 能用、练习不能用」的**真正根因**。
>
> 现在 T 由 `src/lre-emu.js` 在 JS 里**执行同一段机器码**算出（指令表见
> `src/lre-insns.js`，由 `tools/gen-lre-insns.py` 用 capstone 离线生成），
> 平台无关、零外部依赖。
>
> **正确性判据**：`src/sign.js` 里那份真机抓包的 T fixture，其对应分钟为
> `M = 29839199`（可由 fixture 中的 `M//9 = 3315466`、`M//3 = 9946399`
> 反推锁定）——模拟器在该点的输出与 fixture **逐字节一致（410/410）**。

#### ★ 出题冷却：62 秒的旧结论已作废（2026-10-01 复测）

`62s/账号` 是 2026-09-28 的实测值，**当前服务端已放开**：

```
同一账号连续出题（间隔 1.5s） × 4  →  全部 200，无 429
成功出题后隔 1.1s 再出题          →  200（放行）
```

所以 `MATCH_COOLDOWN_MS` 已从 `62_000` 改为 **`1_500`**（可用
`PK_EX_MATCH_COOLDOWN_MS` 覆盖），另把配速安全边距从 1000ms 降到 200ms
—— 之前 1000ms 的安全边距会把 1s 的冷却**完全抵消**，导致每轮都撞 429
再白等 10 秒重试，比不配速还慢。

实测效果：**5 轮 × 100 题（1000 经验）共 6.3 秒，零 429**。

#### 三条链路

| 链路 | 端点 | 状态 |
|---|---|---|
| **出题** | `POST /leo-math/android/exams`（form: `keypointId` + `limit`） | ✅ 每题自带 `answer` |
| **经验上报（刷分）** | `POST /leo-star/.../rank/login/attend`（`@NeedEncode`） | ✅ 每次 +200 |
| **整卷提交** | `PUT /leo-math/android/exams/{examId}`（**不是 `/v2/`**，`Content-Type: application/json`，**body 是 JSON 明文不编码**） | ✅ **已打通**：必须带笔迹 `script`，服务端靠回放笔迹判卷（不信任 `status`） |

#### 刷分的硬上限（实测）

**每个可记账 `ruleType` 每天只记一次**，实测**只有 `0` 与 `1` 有效** ⇒ 日上限 **400 分**。
同一 ruleType 当天再报会返回 `200 {data:true}` 但**分数不动**（服务端静默去重）。

#### 练习页

网页顶部多了「**刷练习**」tab：

- **自动刷练习**：`出题 → 抄答案 → 提交` 完整闭环（`/api/exercise/run` + SSE 实时日志 `/api/exercise/stream`）。
  引擎按出题冷却（≈62s/账号）自动配速，撞频控（429）自动重试；建议 `limit=100`（=200 经验）。
- 刷新分数/任务、经验上报（刷分）、只看题（不提交）。

### 5. 登录（短信 / 密码）的加密口径 —— **两条路的字段不一样**

| 接口 | 字段 | 加密？ |
|---|---|---|
| `POST /verifier/android/sms` | `phone` | **RSA 密文** |
| `POST /accounts/android/safe/login`（短信） | `phone` | **RSA 密文** |
| `POST /accounts/android/safe/login`（短信） | `verification` | **RSA 密文**（最容易漏） |
| `POST /accounts/android/safe/login`（密码） | `phone` | **明文** |
| `POST /accounts/android/safe/login`（密码） | `password` | **RSA 密文** |

- RSA：`RSA/ECB/PKCS1PADDING` + 原版硬编码 1024 位公钥，Base64 输出（`src/crypto-rsa.js`）。
  `node:crypto` 原生支持，**不需要任何第三方库**。
- PKCS#1 自带随机填充 → 同一手机号每次密文不同，**这是预期行为**。

#### 发短信的返回语义（实测，别把冷却当失败）

| 返回 | 含义 |
|---|---|
| `200` + 空体（`x-yfd-service: fenbi-verifier`） | 已发出 |
| `403` + `{"message":"已发送短信验证码"}` | **此前已发、正在冷却 —— 不是失败**，直接填收到的验证码即可 |
| `403` + `{"message":"验证码获取失败"}` | `phone` 没加密或号码有问题 |

前端对「冷却」会显示倒计时并提示「直接用收到的验证码」，不会报错吓人。

### 6. 为什么不用主域网关版登录

`POST /leo-gateway/android/auth/password`（主域）实测**无论明文还是 RSA 密文
一律 401 `unauthorized`**，拿不到任何语义化错误；而直连
`ape-api.yuanfudao.com/accounts/android/safe/login` 能给出
`401 {"message":"密码错误"}` 这种明确信息。所以本项目只走直连版。

---

## 4.10 ★ 子账号切换 + 子账号明细（2026-09-28 攻破）

**旧结论「switch 恒 417、是传输层指纹、做不到」被完全推翻。**

### 真正的三个条件
| # | 条件 | 错的后果 |
|---|---|---|
| 1 | `_productId` 必须在查询串**最前** | 放最后 → **400** |
| 2 | **必须带 `sign`** | 不带 / 带旧 sign → **417**（417 = sign 校验失败，**不是** TLS 指纹） |
| 3 | 主域公共参数 `version=3.140.1` + `platform=android37` | 用 PK 的 `3.141.1/android36` → 400/417 |

### 实测（账号 4，3 个子账号）
```
context: cur=1155551346
POST /leo-gateway/android/accounts/switch   body: targetUserId=511467407
  -> 200 {"code":1,...}   Set-Cookie: 新 sess + userid + ks_*
context: cur=511467407   ★ 切换成功
再切回 -> 200 -> cur=1155551346   ★ 双向可用
```

### 子账号明细 `batchGet` 也通了
`GET /leo-profile/android/user-infos/batchGet`（+sign，android37/3.140.1）→ **200**：
`[{userId, nickname, avatarId, avatarUrl, ...}]` —— 名字/头像不再是「账号 {uid}」。

### 代码
- `src/leo.js`：`buildUrl` 按路径选公共参数（主域 `MAIN_COMMON_QUERY` / PK `COMMON_QUERY`），`_productId` 提到最前。
- `config.signMode` 默认改 **`auto`**（有 arm64 native 就算 sign，没有则跳过）。
- `leo-accounts.js`：`switchToSubAccount(id, targetUserId)` —— 切号 + 用服务端回包校验生效身份 + 写回库。
- ⚠️ **sign 需要 arm64**：Windows/x86 上 switch / batchGet 仍不可用（PK 出题不受影响）。

## 4.9 设备链池与 cookie 加密（2026-09-28）

### 为什么需要设备链
`ks_*`（`ks_deviceid` / `ks_r` / `ks_u` / `ks_sess` / `ks_persistent`）是**设备级**凭据，
原版只有 `POST /leo-auth/android/user-devices` 才会下发 —— 而该路径整段被 `solar-encoder` 拦 **417**（纯 Node 无解）。

**但 `ks_*` 可以不来自设备注册**：把同一台设备的 `ks_*` 复制到别的账号，服务端照样认。实测：

```
pk/match     无 ks_* → 400(×3)        有 ks_* → 200(×3)
完整 PK 一局  跑不了                     ok=true，已结算
```

### 设备链池
`「账号」页 → 设备链池`：粘贴含 `ks_deviceid` 的 cookie 即可入库（按 `ks_deviceid` 去重）。

- **登录导入的账号会自动补链**：没 `ks_*` 时按 `轮询` 从池里挑一份（多份轮换，分摊风险）；
- 导入完整 cookie 时，若自带设备链也会**自动收进池子**；
- 池空则回退：从库里任意「有设备链的账号」借一份。

API：`GET/POST /api/device-chains`，`DELETE /api/device-chains/:id`。

### cookie 加密
所有 cookie 的 **value** 在库里都是 **AES-256-GCM** 密文：

```
enc:v1:<b64 iv12>:<b64 tag16>:<b64 ciphertext>
```

- 密钥：`PK_SECRET`（≥16 字符，推荐）→ `sha256(PK_SECRET)`；否则 `data/secret.key`（32 随机字节、0600、首启自动生成）。
- `name/domain/path` 保持明文（便于「只列 cookie 名」，页面永不回显 value）。
- **历史明文自动迁移**：启动时检测到明文就加密，并 `VACUUM` 清掉旧页（`POST /api/leo/accounts/migrate-crypt` 可手动触发）。
- ⚠️ **密钥别丢**：丢了 = 已加密的 cookie 无法解密，需要重新导入账号。

## 五、使用流程

三种添加小猿账号的方式，效果完全一致（都走同一套「探活 + 拉子账号 + 落库」）：

### 方式 1：短信验证码登录（推荐）
1. 网页 →「小猿账号」→ 选「短信验证码登录」；
2. 填手机号 → 点「发送验证码」；
3. 填收到的验证码 → 点「登录」。

> 若提示「验证码此前已发送（服务端冷却中）」，说明短时间重复请求了 ——
> **直接填上一条短信里的验证码**即可，不是错误。

### 方式 2：密码登录
手机号 + 小猿账号密码 → 登录。
（密码会 RSA 加密后提交，本地不留存密码。）

### 方式 3：粘贴 Cookie
适合没有密码、也收不到短信的场景。从已登录的小猿环境导出 cookie：
必备 `sess`；带上 `userid` 才能确定身份；`sid` 探活时服务端会补发（本项目会自动收下）；
`ks_*` 是**设备链**，只有原版 App 调 `POST /leo-auth/android/user-devices` 才会下发 —— 
本服务拿不到（该路径整段被 `solar-encoder` 拦 417），缺它只影响「子账号昵称/头像」与「切换子账号」，**不影响刷局/刷练习**。
支持整行 `Cookie:` / 每行 `name=value` / JSON 数组三种格式。

### 然后刷局
网页 →「刷局」→ 选账号 / 子账号 / 知识点（可点「拉取知识点」）→ 局数 → 开始。
右侧实时日志看每轮结果；「任务」页可查历史与逐轮明细。

**高级参数**（点开「高级参数」折叠区）：

| 参数 | 说明 |
|---|---|
| `costTime`（毫秒） | 整卷耗时，写进提交体。**留空 = 自动**（按题数 × 5ms 给下限，避免 0ms 不自然）。 |
| 画笔算法 | `弧线（推荐）` = 密集弧线 21/24 点，服务端接受，**PK 默认**；`七段码` = 字形折线，可能被判作弊 403，仅作对照。 |
| 每轮最小 / 最大间隔 | 轮与轮之间的随机等待，用来规避频控。默认 12000~20000ms。 |
| 频控退避基数 / 最大次数 | 遇到 403 频控时的退避策略：`基数 × 2^n`，默认 60000ms、最多 2 次。 |

> 画笔算法两种模式的**坐标口径不同**（弧线是像素坐标 x≈150-240；七段码是归一化 ×1000），
> 不要试图统一 —— 见 `src/strokes.js` 顶部注释。
> 弧线模式下若题目答案不是 `>` / `<`，会**自动回落**到七段码。

### 命令行等价操作

```bash
# 自检（native / sign / RSA / 笔画 / body 结构 / 编码器）
node bin/selftest.js

# 重置管理员密码
node bin/reset-admin.js 新密码

# 下载穿透客户端（可选）
sh bin/get-cloudflared.sh
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PK_HOST` | `127.0.0.1` | 监听地址。`0.0.0.0` 则局域网可访问 |
| `PK_PORT` | `8787` | 端口（`start.sh` 会自动避让被占用的端口） |
| `PK_DB` | `data/pk-node.sqlite` | SQLite 路径 |
| `PK_ADMIN_USER` / `PK_ADMIN_PASS` | `admin` / `admin` | 首次启动写入的管理员 |
| `PK_MAX_CONCURRENT` | `3` | 最大并行任务数 |
| `PK_SHEPHERD_DID` | 空 | 风控设备标识 `x-shepherd-did`，见下 |
| `PK_DEVICE_BRAND` / `PK_DEVICE_MODEL` / `PK_DEVICE_SDK` / `PK_DEVICE_SCALE` | `Redmi` / `25053RT47C` / `37` / `3.25` | 拼 App 原生 UA 用，建议按自己设备改 |

> `PK_DEVICE_*` 必须与**你自己设备**一致：主域风控会核对 UA。
> 用 `getprop ro.product.brand` / `ro.product.model` / `ro.build.version.sdk`
> 与 `ro.sf.lcd_density`（除以 160 得到 Scale）取值。

**`PK_SHEPHERD_DID` 怎么拿**（需 root）：

```bash
strings /data/data/com.fenbi.android.leo/files/mmkv/leo_shepherd_id \
  | grep didKey | head -1 | sed 's/.*String%\$//'
```

它是宿主 App 从服务端同步、持久化在本机的**设备级凭据**。本服务不复刻那套同步链路，
直接沿用同机宿主的值（与「导入登录态 cookie」同一思路）。
留空则不发送该头 —— PK 系接口不受影响，主域部分端点可能因此 417。

---

## 六、穿透（可选）

网页「穿透」页点启动，等价于：

```bash
bin/cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
```

- 免账号，得到一个 `https://xxxx.trycloudflare.com`。
- **进程停止即失效，下次是另一个随机域名。**
- **地址本身无鉴权** —— 任何拿到地址的人都能打开登录页。所以：
  - 立刻改掉 `admin/admin`；
  - 不用时点「停止穿透」；
  - 别在公开场合贴地址。

---

## 七、安全与已知限制（如实说明）

| 项 | 说明 |
|---|---|
| cookie 存储 | ✅ **已加密**：`leo_accounts.cookies_json` / `device_chains.cookies_json` 里每个 cookie 的 **value 都是 AES-256-GCM 密文**
（`enc:v1:iv:tag:ct`），密钥来自 `PK_SECRET`（≥16 字符）或 `data/secret.key`（0600，自动生成）。
**光拿到 db 文件打不开登录态与设备链**；要同时拿到密钥文件才行。默认只监听 `127.0.0.1`。 |
| 默认密码 | `admin/admin` 只是为了「开箱能进」。**对外暴露前必须改密**。 |
| 频控 | 服务端对提交接口有独立频控窗口。刷太快会 403/400，属正常保护，不是本项目的 bug。 |
| 风控 | 连续高频出题可能触发「已封禁，暂时无法使用」的短时冷却，等几分钟再试。 |
| 设备链 | **PK 出题必须带 `ks_*`**（没它 `pk/match` 恒 400）。本服务用「**设备链池**」解决：多份来源存进池子，登录导入的账号自动挑一份补齐（多份轮换）。 |
| 子账号切换 | ✅ **已攻破**（见 4.10）：需 `sign` + `_productId` 最前 + `android37/3.140.1`。子账号名字/头像（batchGet）也 ✅。⚠️ 依赖 arm64 sign，Windows/x86 不可用。 |
| 短信登录 | 未实现（默认走「导入登录态」）。如需要按 `ape-api.yuanfudao.com/accounts/android/safe/login` 补。 |

---

## 八、故障排查

| 现象 | 处理 |
|---|---|
| 启动报 `缺少 native 资产` | 确认 `bin/native/` 齐全（见第二节），跑 `node bin/selftest.js`。 |
| 启动报 `EADDRINUSE` | 端口被占：`PK_PORT=8790 ./start.sh`。 |
| 导入 cookie 报「上下文接口 HTTP 401/417」 | cookie 过期或域不对；重新导出（需含 `sess`，域 `.yuanfudao.com`）。 |
| 提交一直 403 / 400「请求过于频繁」 | 服务端频控。停一会儿，或调大「频控退避基数」。 |
| 出题 400「已封禁，暂时无法使用」 | 短时风控冷却，等待后重试。 |
| 看不到子账号昵称 | 明细接口需设备链（见上），不影响刷局。 |

---

## 免责声明（完整版）

> **本项目（pk-node）仅供学习、研究与技术交流使用。**

1. **用途限制**
   本项目仅用于学习 Android 客户端的网络协议、加固实现与逆向分析等技术。
   **严禁**将本项目或其衍生代码用于：商业用途、批量刷分、代练、账号交易、
   攻击或干扰任何平台正常运行、以及任何违反所在地区法律法规或平台服务条款的行为。

2. **风险自负**
   使用本项目产生的一切后果（包括但不限于账号被封禁、数据丢失、法律风险）
   **由使用者自行承担**。作者不对任何直接、间接、附带或后果性损害负责。

3. **无关联声明**
   本项目为个人技术研究作品，与「小猿口算」及其运营方（北京猿力教育科技有限公司等）
   **无任何隶属、合作或授权关系**，也未获其认可或赞助。

4. **知识产权**
   项目中出现的「小猿口算」等名称、商标、App 资源，以及 `bin/native/` 下的
   第三方二进制（Android 系统库、NDK 运行库、App 原生库等），
   版权均归各自权利人所有，本项目**不对其主张任何权利**。
   详见 [bin/native/NOTICE.md](bin/native/NOTICE.md)。项目自身代码以 [MIT License](LICENSE) 授权。

5. **侵权处理 —— 立即删除**
   若你是权利人，并认为本仓库的任何内容（代码、文档、二进制、截图等）侵犯了你的合法权益，
   请通过 **GitHub Issues**（或仓库主页邮箱）告知。**一经核实，将立即删除相关内容，
   必要时删除整个仓库，无需另行通知。**

6. **合规使用**
   请在**取得合法授权**、且**仅用于自身学习研究**的前提下使用本项目。
   请勿将其用于任何可能损害他人或平台利益的行为。

> **下载、安装、阅读源码或运行本项目，即视为你已阅读、理解并同意以上全部条款。**
> 若不同意，请立即停止使用并删除全部相关文件。
