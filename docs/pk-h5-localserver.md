# pk-h5 私服 —— 自己写业务逻辑

> 目标：给小猿口算 PK 那套 H5（`leo-web-oral-pk`）跑一个**我们自己的服务端**。
> 出题、判分、结算、榜单全部由本服务生成，**不访问小猿服务器，不需要小猿账号**。

---

## 一、它和「代理模式」的区别

pk-node 里有两套应答 H5 请求的方式，靠开关切换，互不干扰：

| | **代理模式**（原有） | **私服模式**（本模块） |
|---|---|---|
| 实现 | `src/pk-h5-proxy.js` | `src/pk-h5-localserver.js` |
| 请求去向 | 转发到真实小猿服务器 | **就地生成** |
| 需要小猿账号 | 需要（用它的 cookie 出站） | **不需要** |
| 出题 | 小猿出 | **我们自己出** |
| 判分 | 小猿判 | **我们自己判** |
| 榜单 | 小猿的榜 | **我们自己的榜** |
| 依赖网络 | 要 | 不要 |

切换：后台「私服」页点按钮，或 `POST /api/localserver/mode {mode:"local"|"proxy"}`。
单次请求也可用 URL 参数 `?__local=1` / `?__local=0` 覆盖。

---

## 二、为什么必须自己实现加密

H5 不是「拿明文 JSON」那么简单：

- 拉题卷：`POST .../math/pk/match/v2`，`responseType:'arraybuffer'`，
  拿到**密文**后调桥 `LeoSecure.dataDecrypt` 解密。
- 交卷：`PUT .../math/pk/submit`，先把明文交给桥 `dataEncrypt` 加密，
  `content-type: application/octet-stream`。

所以私服必须能：

```
出：明文 → gzip(设备口径) → keystream XOR → 密文 Buffer
入：密文 Buffer → keystream XOR → gunzip → 明文
```

这两条链路复用 `src/native.js` 的 `encodeSubmitBody` 和 `src/keystream.js` 的 `xorEncode`
（它们本来就是为「模拟真机编码」写的，与真机逐字节一致 —— 见 `bin/selftest.js`）。
**没有新增任何密码学实现**，只是把已有能力用在反向方向。

---

## 三、接口清单（从 bundle 里逐行读出来的，不是猜的）

| 方法 | 路径（`{client}` 会被 H5 换成 `api`） | 响应 |
|---|---|---|
| GET | `/leo-game-pk/{client}/math/pk/home?grade=N` | 明文 JSON（首页卡片） |
| POST | `/leo-game-pk/{client}/math/pk/match/v2?pointId=X` | **密文**（题卷） |
| PUT | `/leo-game-pk/{client}/math/pk/submit` | body 是**密文**，响应明文 |
| GET | `/leo-game-pk/{client}/math/pk/history/detail?pkIdStr=X` | 明文 JSON（结算页） |
| GET | `/leo-game-pk/{client}/game/rank?...` | 明文 JSON（榜单） |

私服不实现的周边接口（成就、道具、签到…）统一回
`{code:200, message:'ok', data:{}}`，让页面能正常渲染、不卡住 —— **绝不转发**。

### 数据结构来源

首页/题卷的字段名**不是猜的**，参考据点是 bundle 里自带的原版开发 mock
（`/root/pk-h5-fulldeobf/beautified/leo-web-oral-pk/assets/index-legacy.DqAYjRZL.js`，
里面有 `getHomeData` 返回的完整字段表）。少一个字段页面就白屏，所以照着它对齐。

---

## 四、判分口径（私服的核心价值）

H5 交上来的每题含 `userAnswer`（手写识别结果）和 `status`（页面自报对错）。

**私服不信 `status`**，按服务端留底的正确答案逐题**重判**：

```js
const ok = ua !== '' && ua === String(q.answer);   // 以服务端的 answer 为准
```

答案只在服务端保存，题卷发给 H5 时**不带答案**（`examVO` 里没有 `answer` 字段的口径暴露）。

实测：
- 全对提交（哪怕把 `status` 谎报成 3、`correctCnt` 报 0）→ 服务端仍判 `10/10` ✔
- 故意错 3 题 → 服务端判 `7/10`，`win=false` ✔

---

## 五、内置题库

7 个题型，`pointId` 对齐真实小猿的知识点 ID：

| pointId | 名称 | 生成规则 |
|---|---|---|
| 1 | 一二年级·加减法 | 20 以内加 / 减 |
| 2 | 一二年级·减法 | 30 以内减法（保证不出负数） |
| 3 | 三年级·乘法口诀 | 2–9 乘 2–9 |
| 4 | 三四年级·除法 | 整除（先定商再乘） |
| 2035 | 20以内加减法 | 加/减各半 |
| 2036 | 100以内加减法 | 加/减各半 |
| 99 | 混合运算 | `a×b+c` / `a×b-c` / `a+b×2` |

支持**题库覆盖**：往 `data/pk-h5-localserver/pk-h5-localserver.json` 的
`banks.<pointId>` 里塞 `[{content, answer}]`，出题时优先用它（不够则回落到现场生成）。
这样可以把私服变成「按自己的题单练习」。

---

## 六、数据与存储

```
data/
├── pk-h5-mode.txt                     # 当前模式：local / proxy
└── pk-h5-localserver/
    └── pk-h5-localserver.json         # 对局记录 / 题库覆盖 / 榜单 / 统计
```

刻意用 JSON 而不是 SQLite：数据量小（题库 + 对局记录），
用户可以直接打开看、手动改；写入走「临时文件 + rename」保证原子性。

---

## 七、管理接口

全部需要管理员登录：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET/POST | `/api/localserver/mode` | 查询 / 切换模式 |
| GET | `/api/localserver/overview` | 概览：统计 + 最近对局 + 题型表 |
| POST | `/api/localserver/reset` | 清空对局与榜单（题库不动） |
| POST | `/api/localserver/selftest` | 跑一遍「出题 → 判分」闭环自检 |

后台「私服」页（管理员可见）把这些按钮化了，并带一个实时自测输出区。

---

## 八、验证记录

- 单元：`makeMatch` → `seal` → `open` 往返一致 ✔
- 单元：全对判 10/10、错 3 题判 7/10 ✔
- HTTP：经 `/api/pk/h5/api`（H5 真实调用口径 + `X-PK-Path` 头）走通出题/判分/结算/榜单 ✔
- 管理端：登录 → 切模式 → 自测 → 概览 ✔
- 回归：`bin/selftest.js` 全部通过 ✔

---

## 九、已知边界（如实说明）

| 项 | 现状 |
|---|---|
| 多账号 / 真人 PK 匹配 | **未实现**。当前是单人对局：出题、判分、记榜。8 人 PK、好友 PK 走代理模式 |
| 英语 / 诗词 PK | **未实现**，走代理模式 |
| 笔迹识别 | 不实现。H5 的答题板自己识别手写，私服只拿 `userAnswer` 文本 |
| 榜单 | 本地单人榜（自己跟自己比），不是全服榜 |
| 赛季 / 活动 | 未接 |
