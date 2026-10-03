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
./start.sh                 # 默认监听 0.0.0.0:8792（启动横幅会打印局域网访问地址）
PK_PORT=8790 ./start.sh    # 换端口
PK_HOST=127.0.0.1 ./start.sh  # 只监听本机（不对外暴露）
```

Windows：双击 `start.bat` —— **可完整刷局 + 刷练习**（内容编码是纯 JS；`sign` 也已改成纯 JS 模拟 arm64 机器码，不再需要 WSL / arm64）

> ★ 2026-10-01：`start.sh` 与 `start.bat` 现在**都只是薄壳**，真正的
> 「Node 版本校验 / 挑空闲端口 / 打印横幅」都在 `bin/start.js` 里（一份代码两个平台）。
> 之前 `start.bat` 在 Windows 上跑不起来，真因是它是 **LF 行尾**（cmd.exe 要求 CRLF，
> `if errorlevel … (` 这种多行结构会被当成一行解析直接报错），且端口探测写成了
> `for /f … node -p …`，在 UTF-8 中文的 bat 里容易被代码页搅乱。现在 bat 只有
> 十几行、**纯 ASCII + CRLF**，不再需要 Git/MSYS2。

浏览器打开 → 用 `admin / admin` 登录（**第一次登录后请立刻改密**）。

---
## 🚀 使用教程（快速上手）

> 完整说明见 [第五节 使用流程](#五使用流程)；这里是最短路径。

### 第 1 步 · 启动服务
```bash
git clone https://github.com/sxd91/pk-node.git && cd pk-node
./start.sh                     # Windows：双击 start.bat
# 默认 http://0.0.0.0:8792，启动后横幅会给出局域网地址（端口被占会自动避让）
```
或直接下 [免安装包](https://github.com/sxd91/pk-node/releases/latest) 解压运行（**推荐**，免 `npm install`）。
需要 **Node.js ≥ 22**（用到内置 `node:sqlite`），除此之外**零依赖**。

### 第 1.5 步 · 从别的电脑 / 手机访问（局域网、公网）

> ★ 2026-10-03 修复：以前默认 `PK_HOST=127.0.0.1`（**只监听回环**），
> 局域网 IP:8792 和公网 IP:8792 一律连不上 —— 请求在 TCP 层就被拒，
> 连 401 都收不到，很容易被误判成"防火墙/鉴权"的问题。
> **现在默认就是 `0.0.0.0`（监听所有网卡），启动横幅会直接把局域网地址打出来。**

三种场景，从易到难：

**① 同一局域网（台式机 → 手机 / 另一台电脑）** —— 现在就能用

启动后横幅会打印形如 `局域网访问: http://192.168.3.72:8792` 的地址，
手机上打开那个地址即可（手机需连同一个 Wi-Fi）。

> 打不开先查这两条：
> 1. **Windows 防火墙**会拦入站。首次监听时放行一次（管理员权限的 cmd）：
>    ```
>    netsh advfirewall firewall add rule name="pk-node" dir=in action=allow protocol=TCP localport=8792
>    ```
> 2. 确认横幅里的地址是**你手机能路由到的那块网卡**的 IP（别挑 VMware / WSL 的虚拟网卡）。
>    只想让某一块网卡暴露，更安全：`PK_HOST=192.168.3.72 ./start.sh`

**② 公网 IP + 端口** —— 需要路由器端口映射

1. 路由器后台做 **端口映射**：外网 `8792` → 这台机器的内网 IP `192.168.3.72:8792`。
2. 光有映射还不够，本机防火墙那条规则（上面①）同样要放行。
3. 家宽多半是**动态公网 IP**，且很多运营商主动封 80/443，建议用非 80 端口。
4. 公网暴露前**务必改掉 `admin/admin`**，并考虑 `PK_HOST` 只绑内网 IP。

**③ 免配置公网访问** —— 网页「穿透」页点启动

用内置的 Cloudflare 快速隧道（`*.trycloudflare.com`），不用改路由器。
详见 [第六节 穿透（可选）](#六穿透可选)。

> ⚠️ 一旦暴露到公网，登录口就会变成撞库面。服务端已内置**失败限流**
> （同一来源 IP 10 分钟内失败 20 次 → 429 封禁 10 分钟，可用
> `PK_LOGIN_FAIL_MAX` / `PK_LOGIN_FAIL_WINDOW_MS` 调整）。
> 但别指望它替你挡住 —— **去「管理 → 用户」把 `admin/admin` 改掉才是根本**。

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
| **刷练习** ⭐ | 「刷练习」tab → 选账号 / 知识点 / `limit` / 轮数 → 开始 | 出题→抄答案→提交**全自动闭环**。经验 = 答对题数 × 2（**100 题 = 200 经验**）。轮数**无上限**；任务是**正经后台任务**（落库、可在「任务」页看进度、可停止、切走/关掉浏览器都继续跑） |
| 刷 PK 对局 | 「刷局」tab → 选子账号 / 知识点 / 局数 → 开始 | 右侧 SSE 实时日志；「任务」页可查逐轮明细 |

### 第 5 步 · 看结果
- 「刷练习」/「刷局」页的**实时日志**逐轮显示：出题 → 提交 → 服务端判对 X/Y → 经验 +N。
- 分数以**服务端 `curWeekScore` 为准**（「刷新分数/任务」按钮可随时读）。

### 命令行等价操作
```bash
node bin/selftest.js          # 自检（native / sign / RSA / 笔画 / 编码器）
node tools/check-inject.js    # H5 注入脚本（语法 + 桥协议）
node tools/test-pk-h5-bot.js  # PK H5 三个自动能力的回归测试
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
| 管理后台 | 用户管理（新增/重置密/**禁用即踢下线/删除**）、全部任务（**看配置 / 暂停 / 继续 / 停止 / 明细 / 批量操作**）、审计日志、系统自检。 |
| 穿透 | `cloudflared` 快速隧道 → `*.trycloudflare.com`（免账号，进程停即失效）。 |

### 管理与批量（2026-10-01 新增）

- **批量开任务**：「刷局」和「刷练习」页各有一个「批量开任务」折叠区 ——
  勾选多个小猿账号（支持全选）→ 一键全部按**当前面板同一套配置**开任务，
  每个账号一个独立任务，可单独暂停 / 继续 / 停止。
- **暂停 / 继续**：任务可以「暂停」（立即中断、保留已刷轮数），之后从
  `已刷 + 1` 轮**原地续跑**（同一个任务 id，日志流不断）。「任务」页和管理页都有按钮。
- **管理页看所有人的任务**：每条任务显示归属用户、小猿账号名、是刷局还是刷练习、
  以及**完整参数快照**（知识点 / 画笔 / 间隔 / 频控 / 每轮题数…）；
  支持**暂停 / 继续 / 停止 / 明细（含实时日志）/ 批量勾选操作**。
- **禁用 = 立刻生效**：点「禁用」的一瞬间，该用户**所有进行中任务被暂停**、
  **所有登录会话被清掉**（现有页面当场 401 踢回登录页），也无法再登录或开新任务。
  重新启用后任务保持暂停，由用户自己决定是否「继续」。
- **删除账号**：管理页用户卡片新增「删除」（二次确认）。会先停掉其任务、清掉会话，
  再连带删除名下**全部小猿账号 / 历史任务 / 逐轮明细**（外键级联）。保护规则：
  不能删自己、不能删最后一个管理员。

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
├── start.sh                # 启动脚本（薄壳：找到 node → 交给 bin/start.js）
├── start.bat               # 同上（Windows；纯 ASCII + CRLF，cmd 直接可跑）
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
│   ├── start.js            # ★ 真正的启动器：Node 版本校验 + 挑空闲端口 + 横幅
│   ├── selftest.js         # 命令行自检
│   ├── pick-port.js        # 挑空闲端口（独立小工具，start.js 已内置同样的逻辑）
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

因此本项目**串行**跑任务，且默认 `10s × 2` 退避（基数 10000ms，最多重试 2 次）—— 可在网页高级参数里改。
并发提交只会把请求一起打进频控窗口。

### 4.2 出题接口的冷却：**≈ 60 秒，按账号**（2026-09-27 实测；2026-10-01 再次确认仍在）

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

> ### ★★ 2026-10-01 复测修正：冷却**没有消失**，但引擎改成「不强制、只建议」
>
> 中途有一次复测（同账号连续出题、间隔 1.5s，4 次全 200）曾被当成
> 「服务端已放开」；**后续实测推翻了这个结论 —— ≈60 秒的账号级出题冷却依然在**。
>
> 现在的产品口径（这也是代码里的实现）：
>
> | 谁 | 行为 |
> |---|---|
> | **引擎** | `PK.matchCooldownMs` 默认 **0** —— **不强制**替你等冷却，节奏由用户在网页上填的「每轮最小/最大间隔」决定 |
> | **网页** | 这两个框默认填 **0 / 0**（不等冷却），出题端由「出题频控重试」在背景里蹲；并明确提示「服务端有约 60 秒冷却，靠重试来等」。旁边还有「填入推荐值」按钮（输入框的值会持久化到 localStorage，改 HTML 默认值对老用户不生效） |
> | **兜底** | 撞到 400/403 仍按「出题频控重试间隔」（默认 10s）重试，累计超「出题最长等待」（默认 120s = 2 分钟）才判该轮失败 —— 所以间隔设小了也不会立刻白跑，只是等待会挪进重试里、日志多几行 |
>
> 用户要是偏要设 1000ms：不拦，能跑，只是日志会出现一串
> 「出题被频控…自动重试」，整体耗时反而比默认配置更长。
>
> 想让引擎**自动**贴着冷却下沿跑（不依赖用户填数）：
> `PK_MATCH_COOLDOWN_MS=61600`。
>
> ⚠️ **练习链路没有这个冷却**（那边实测 ~1 秒，见 4.7），两边的结论不要互相套用。
>
> 同一思路也应用到 **H5 PK 页面**：代理侧对 `match` 的 400/403/429 会**自动退避重试**
> 最多 6 次 —— 详见 [4.11](#411-pk-h5-三个自动能力2026-10-01-修好)。

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

#### ★ 练习链路的出题冷却：≈1 秒（2026-10-01 复测）

⚠️ 这一条**只适用于练习**（`/leo-math`）；**PK 的 ≈60s 冷却是另一回事，仍然在**
（见 4.2）。两条链路的冷却**不要互相套用**。

练习侧实测：

```
同一账号连续出题（间隔 1.5s） × 4  →  全部 200，无 429
成功出题后隔 1.1s 再出题          →  200（放行）
```

所以练习的 `MATCH_COOLDOWN_MS` 是 **`1_500`**（可用
`PK_EX_MATCH_COOLDOWN_MS` 覆盖），配速安全边距 200ms
—— 之前 1000ms 的安全边距会把 1s 的冷却**完全抵消**，导致每轮都撞 429
再白等 10 秒重试，比不配速还慢。

实测效果：**5 轮 × 100 题（1000 经验）共 6.3 秒，零 429**。

因此**刷练习的「每轮间隔」保持 0~0**（贴着冷却跑最快）；刷局那边也是 0~0，
但背后靠「出题频控重试 10s / 最长等 2 分钟」蹲住 ≈60s 的账号级冷却。

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

- **自动刷练习**：`出题 → 抄答案 → 提交` 完整闭环。建议 `limit=100`（=200 经验）。
  出题冷却实测只有 ~1s（见上），撞频控（429）自动重试。
- 刷新分数/任务、经验上报（刷分）、只看题（不提交）。
- **轮数无上限**（2026-10-01：以前 `Math.min(99, …)` 会把填的大数字**无声改成 99**，
  用户看到的就是「填 >100 也按 100 算」，已改为只挡非法值）。
- **是正经后台任务**（2026-10-01）：`POST /api/exercise/run` 现在会
  ① 往 `jobs` 表写一条 `config.kind='exercise'` 的记录、② 交给
  `jobs.startExerciseJob()` 跑。于是：
  - 「任务」页能看到它（标题带 `[刷练习]`），可看**逐轮明细**；
  - 可以「停止」（立即中断在途请求与轮间隔等待）；
  - **切到别的 tab、甚至关掉浏览器，服务端都会继续跑完**；
  - 回到「刷练习」页会按 localStorage 记的 jobId 重新挂上日志流
    （`/api/exercise/stream` 仍保留，事件里带 `jobId` 供过滤；多用户互不可见）。
  - 进程重启时，残留的 `running/queued` 任务会被自动标成「服务重启，任务已中断」，
    不会再有永远「运行中」的僵尸任务。

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
- ⚠️ **sign 不再需要 arm64**（2026-10-01 起为纯 JS 复刻，见 4.7），
  所以 switch / batchGet 在 Windows/x86 上同样可用。

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

**补链优先级（高 → 低）**

1. **粘贴内容自带的设备链** —— 从 App / 浏览器整段复制 cookie 时里面往往就带着 `ks_*`，
   这次导入就优先用这份（而不是被池里另外一份覆盖）；
2. **这个账号自己指定的那一份**（下面的「账号 → 设备链」）；
3. 都没指定 → 从池里 `enabled` 的份里**随机挑**（多份轮换，分摊风控风险）；
4. 池空 → 从**同一个用户**已有的账号里借一份（不再跨用户借）。

其他规则：

- 导入带设备链的 cookie 时，这份设备链会**自动收进池**并绑到该账号上 —— 之后刷局 / 刷练习都用这条链，
  不会每次随机换掉。重复粘同一条 `ks_deviceid` 只更新不新增；
- 已导入账号在卡片上可以**直接下拉指定这个账号用池里哪一条**（选「自动」= 跑到时才随机挑）。

### 账号 → 设备链（每个账号各用一条）
账号是**每个用户自己的**，用户可以给每个账号指定池里的某一台设备：
`「账号」页 → 已导入账号` 每张卡片底部的下拉。

- 下拉选具体某条链 → 该账号后续所有任务用这条（任务取 cookie 时也会把这份 `ks_*` 盖上去）；
- 选「自动（池里轮换一份）」→ 回到随机策略；
- 设备链被删 → 绑在它上面的账号自动退回「自动」；
- 池列表会显示「被 N 个账号指定使用」。

API：`GET/POST /api/device-chains`，`DELETE /api/device-chains/:id`，
`PUT /api/leo/accounts/:id/chain`（`{deviceChainId}`，`null` = 自动）。

### cookie 加密
所有 cookie 的 **value** 在库里都是 **AES-256-GCM** 密文：

```
enc:v1:<b64 iv12>:<b64 tag16>:<b64 ciphertext>
```

- 密钥：`PK_SECRET`（≥16 字符，推荐）→ `sha256(PK_SECRET)`；否则 `data/secret.key`（32 随机字节、0600、首启自动生成）。
- `name/domain/path` 保持明文（便于「只列 cookie 名」，页面永不回显 value）。
- **历史明文自动迁移**：启动时检测到明文就加密，并 `VACUUM` 清掉旧页（`POST /api/leo/accounts/migrate-crypt` 可手动触发）。
- ⚠️ **密钥别丢**：丢了 = 已加密的 cookie 无法解密，需要重新导入账号。

## 4.11 PK H5 三个自动能力（2026-10-01 修好）

网页「PK 页面」tab 上那三个勾选框（**视为正确答案 / 自动提交画笔 / 自动下一局**）
此前是**完全无效**的。三个独立真 bug，都已定位到源码/实测：

### ① `?pkbot=` 参数在子页面丢了 → 三个开关全部回到「关」

- 入口页 `pk.html` 的 URL 上带 `pkbot=answer,autoStroke,autoNext`；
- H5 跳 `exercise.html` / `result.html` 时是自己拼 URL 的（只带业务参数），
  注入脚本的 `addLeoId()` **又只补 `leoAccountId`** → 子页面读不到 `pkbot`，
  localStorage 里也没存过 → `pkBotCfg()` 返回全 false。

后果（正是用户看到的现象）：
- `recognize` 桥收到「关」→ 直接回**空串** → 手写识别永远判错
  （「即使写的是正确符号，也完全没有用，根本做不了」）；
- `autoStroke` / `autoNext` 同理，一个都不跑。

**修法（互为保险）**：① 跳转时把 `pkbot` 一起带上；② `pkBotCfg()` 一旦从 URL
读到就写进 localStorage（同源共享，子页面天然继承）。

### ② 「自动提交画笔」发的是手写板**根本不监听**的事件

手写板（`useRecognizeBoard-legacy` 里 signature_pad 的那份移植）是以
`forceUseTouch: true` 创建的，`on()` 的分支是：

```js
(!window.PointerEvent || mac || forceUseTouch)
  ? (this._handleMouseEvents(), 'ontouchstart' in window && this._handleTouchEvents())
  : this._handlePointerEvents()
```

即**总是绑 mousedown**，浏览器支持触摸时**再**绑 touchstart ——
**从来不绑 `pointerdown`**。而注入脚本原来只 `dispatchEvent(PointerEvent)`，
一笔都进不去。

**修法**：严格镜像它自己的判定 ——
`'ontouchstart' in window` → `touchstart/touchmove/touchend`，否则 →
`mousedown/mousemove/mouseup`（`buttons:1`）。
注意 `_handleTouchStart` 要求 `targetTouches.length === 1`、
`_handleTouchEnd` 要求 `targetTouches.length === 0`，长度给错会被直接忽略。

### ③ 「自动下一局」的按钮文案匹配错了两处

结算页按钮文案来自 `Result-legacy` 的 `_t`：`继续PK` / `再练一次` / `继续挑战`。
原匹配命中「继续」「再来」却**漏了「再练」**，同时**把「返回首页」也算了进去**
（点它等于直接离开结算页，白打一局）。

**修法**：匹配「继续 / 再练 / 再来」开头 + 元素可见（尺寸 > 6px），并去掉「返回首页」。

### 「PK现场太火爆，人太多挤不进去了」是怎么回事

那张弹窗的文案**是图片里的字**（`assets/type-1.Ng7ZhNY2.png`），所以在 H5 的 JS 里
搜字符串永远搜不到。逐行读对局页代码可知它的触发条件只有一个：

```js
catch (h) {
  Fe('/debug/oralPk/exercise/netError', { exception: h });
  if (!Be() || (h.response.status !== 429 && h.response.status !== 400)) { /* 普通重试弹窗 */ }
  else { O.value = true }        // ← 渲染 PkAbnormalDialog(默认 type=1) = 这张图
}
```

⇒ **`match/v2` 返回 400 / 429 就会弹「太火爆」**（服务端的瞬时出题频控）。

**修法**：代理侧 `/api/pk/h5/api` 对匹配类请求（`/match`、`/eliminate/`）的
`400 / 403 / 429` **自动退避重试**（最多 6 次，间隔 0.9s×n，上限 4s），
把瞬时频控挡在代理层；普通接口的 401 仍只重试 1 次，避免登录态失效时整页变卡。
可用 `PK_H5_RETRY_MAX` / `PK_H5_RETRY_GAP_MS` 调整。

### 回归测试

```bash
node tools/test-pk-h5-bot.js    # 20 项断言：recognize / 事件类型 / 下一局按钮 / 频控重试
node tools/check-inject.js      # 注入脚本语法 + 桥协议（每次改 hook 后必跑）
```

---

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
| 每轮最小 / 最大间隔 | **唯一的节奏旋钮**（引擎不强制等冷却）。服务端有 ≈60s 的账号级出题冷却；默认 **0/0**（不等）—— 改由「出题频控重试」在背景里蹲冷却。旁边有「填入推荐值」按钮可一键套用整套节奏。 |
| 出题频控重试间隔 / 最长等待 | 出题撞 400/403 时的重试节奏：默认 10000ms、累计 120000ms（2 分钟）后判该轮失败。 |
| 频控退避基数 / 最大次数 | **提交**遇 403 时的退避策略：`基数 × 2^n`，默认 10000ms、最多 2 次。 |

> 画笔算法两种模式的**坐标口径不同**（弧线是像素坐标 x≈150-240；七段码是归一化 ×1000），
> 不要试图统一 —— 见 `src/strokes.js` 顶部注释。
> 弧线模式下若题目答案不是 `>` / `<`，会**自动回落**到七段码。

### 命令行等价操作

```bash
# 自检（native / sign / RSA / 笔画 / body 结构 / 编码器）
node bin/selftest.js

# PK H5 的「自动能力」回归测试 + 注入脚本校验
node tools/test-pk-h5-bot.js
node tools/check-inject.js

# 重置管理员密码
node bin/reset-admin.js 新密码

# 下载穿透客户端（可选）
sh bin/get-cloudflared.sh
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PK_HOST` | `0.0.0.0` | 监听地址。默认监听所有网卡（本机/局域网都能访问）；设 `127.0.0.1` 则只监听本机，设某块网卡的 IP 则只监听那块 |
| `PK_PORT` | `8787` | 端口（`start.sh` 会自动避让被占用的端口） |
| `PK_DB` | `data/pk-node.sqlite` | SQLite 路径 |
| `PK_ADMIN_USER` / `PK_ADMIN_PASS` | `admin` / `admin` | 首次启动写入的管理员 |
| `PK_MAX_CONCURRENT` | `0`（不限） | 最大并行任务数；`0` = 不限制 |
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
bin/cloudflared tunnel --url http://127.0.0.1:8792 --no-autoupdate
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
**光拿到 db 文件打不开登录态与设备链**；要同时拿到密钥文件才行。默认监听 `0.0.0.0`（局域网可访问），想收回成本机访问就设 `PK_HOST=127.0.0.1`。 |
| 默认密码 | `admin/admin` 只是为了「开箱能进」。**对外暴露前必须改密**。 |
| 频控 | 服务端对提交接口有独立频控窗口。刷太快会 403/400，属正常保护，不是本项目的 bug。**任务之间不限制并行个数**（`PK_MAX_CONCURRENT=0`），任务内部逐轮串行；出题/提交撞频控都会自动退避重试。 |
| 风控 | 连续高频出题可能触发「已封禁，暂时无法使用」的短时冷却，等几分钟再试。 |
| H5 弹「PK现场太火爆 / 挤不进去」 | 对局页在 `match/v2` 返回 **400/429** 时就会弹那张图（文案在图片里）。代理侧已对匹配请求自动退避重试（最多 6 次）；若依旧弹，多半是账号被短时风控（出题 400「已封禁」），等几分钟。 |
| 设备链 | **PK 出题必须带 `ks_*`**（没它 `pk/match` 恒 400）。本服务用「**设备链池**」解决：多份来源存进池子，导入时按「粘贴自带 > 账号指定 > 池轮换 > 同用户其它账号」补链；每个账号可在卡片下拉里指定固定用一条。 |
| 设备链池作用域 | 池本身是**全局**的（所有用户共用一份池子），但「哪个账号用哪条链」是**账号级**的、由账号主人自己配。删链只影响绑定它的账号（自动退回「自动」），不影响已落在账号 cookie 里的 `ks_*`。 |
| 子账号切换 | ✅ **已攻破**（见 4.10）：需 `sign` + `_productId` 最前 + `android37/3.140.1`。子账号名字/头像（batchGet）也 ✅。sign 自 2026-10-01 起是纯 JS 复刻，**Windows/x86 同样可用**。 |
| 短信登录 | 未实现（默认走「导入登录态」）。如需要按 `ape-api.yuanfudao.com/accounts/android/safe/login` 补。 |

---

## 八、故障排查

| 现象 | 处理 |
|---|---|
| 启动报 `缺少 native 资产` | 确认 `bin/native/` 齐全（见第二节），跑 `node bin/selftest.js`。 |
| 启动报 `EADDRINUSE` | 端口被占：`PK_PORT=8790 ./start.sh`（或 `set PK_PORT=8790` 后双击 `start.bat`）。启动器也会自动往后找空端口。 |
| Windows 双击 `start.bat` 一闪而过 | 已修（2026-10-01）：现在 bat 是 **CRLF + 纯 ASCII**，逻辑在 `bin/start.js`。若仍失败，在 cmd 里手动跑 `node bin\start.js` 看报错。 |
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
