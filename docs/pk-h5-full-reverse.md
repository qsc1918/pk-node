# pk-h5 全量逆向规格（真机原版 bundle 逐行读，1:1 对齐）

> **权威源**：真机 `/data/user/0/com.fenbi.android.leo/cache/webbundle/leo-web-oral-pk_1789638371210/`
> build `2026-09-17 09:37:43`，commit `4602ecc688070099847fdd0d3306db5118cc7897`
> 46 个 JS 模块 + `pk.html`（7295B）。分析产物：`/root/h5/analysis/`
>
> 本文所有结论均来自**逐行读该 bundle 源码**，不是猜测、不是抽样。

---

## 一、页面清单（16 个 html，跨 6 个 CDN 目录）

| 页面 | CDN 目录 | 用途 |
|---|---|---|
| `pk.html` | `leo-web-oral-pk` | **PK 主页面（SPA，hash 路由）**。`#/pk-rank` = 榜单页 |
| `exercise.html` | `leo-web-oral-pk` | **对局页**（1v1 / 8人，靠 `isMultiPk` 区分） |
| `result.html` | `leo-web-oral-pk` | **结算页**（`isFromHistory` 区分「看历史」/「真结算」） |
| `school-season.html` | `leo-web-oral-pk` | 校园赛季入口页 |
| `school-season-match.html` | `leo-web-oral-pk` | 校园赛季对局页 |
| `item-oral.html` | `leo-web-oral-pk` | 道具 PK 对局页 |
| `english-words.html` | `leo-web-oral-pk` | 英语单词（`#/word-book`） |
| `english-word-match.html` | `leo-web-oral-pk` | 英语单词对局 |
| `invite-friend.html` | `leo-web-oral-pk` | 好友挑战（`#/`） |
| `pk-activity-result.html` | `leo-web-oral-pk` | 活动结算（8人 PK） |
| `prop-result.html` | `leo-web-oral-pk` | 道具结算 |
| `exercise.html` / `knowledge.html` | `leo-web-poem-pk` | 诗词 PK 对局 / 知识点 |
| `motivation-honor-roll.html` | `leo-web-study-group` | **荣誉榜**（另一个 bundle） |
| `timeover.html` | `leo-web-math-exercise` | 3600s 超时页 |
| `avatar.html` | `leo-web-settings` | 头像（奖励弹窗「去查看」） |
| `gold.html` | `leo-web-rank` | 金币（`#/shop`） |

---

## 二、桥传输协议（**这是「cookie 能力」的真相**）

H5 全程**不读也不写业务 cookie**。它只做一件事：`axios` 开 `withCredentials:true`，靠**同源/浏览器自动带 cookie**。

### 2.1 调用出口（`index-legacy.CHYoHfC0.js`，`Lt` 函数）

按优先级依次尝试：

| # | 条件 | 调用方式 |
|---|---|---|
| 1 | RN 环境 | `NativeModules.RNJsBridge.callNative(module, method, args, cb)` |
| 2 | UA 命中 `/bridgetype\/2/` | `window["<module>_<method>"].postMessage(payload)` |
| 3 | iOS | `window.webkit.messageHandlers["<module>_<method>"].postMessage(payload)`，否则「隐藏 iframe + `async:<module>_<method>:<payload>`」 |
| 4 | Android（`<Module>WebView`） | `window["<Module首字母大写>WebView"][method](payload)` |
| 5 | Android 兜底 | `window.LeoWebView \|\| window.SolarWebViewV2` 的 **`callNative(payload)`** |

> **payload 形态**（`Lt` 里）：`vt({method: "<module>_<method>", params: <业务参数>})`
> `vt()` = `btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))))`
> → **base64(UTF-8(JSON))**
>
> **回调形态**：`window[<callback>](base64(JSON([err, ...data])))`；`err===null`/`0` 为成功。
> 若 H5 传了 `trigger`，则**不注册 callback**，`trigger` 自己当回调名。

### 2.2 命令表握手（`getNativeCommandList`）

```js
// index-legacy.CHYoHfC0.js，页面加载后 setTimeout 0 触发
if (!location.host.includes("xyst.yuanfudao.com") && !isIOS()) {
  var name = "getAndroidNativeCommandList" + Date.now();
  window[name] = function (t) {
    var list = JSON.parse(b64decode(t))[1];
    It = list;                          // 全局能力白名单
    window.__androidNativeCommandList = list;
  };
  window.SolarWebViewV2.getNativeCommandList(vt({ params: { trigger: name } }));
}
```
`It` 用于**校验**后续 `callNative` 的方法名是否在册（不在册只打诊断，不阻断）。

### 2.3 别名的另一条路（`Utils-legacy.Bu69Mvnu.js` 导出 `r`）

```js
(n, t, a, e) => axios({ method:'get',
  url: `https://xyks.yuanfudao.com/leo-bh5-bridge/${a || 'common'}/${n}`,
  baseURL: 'https://xyks.yuanfudao.com', params: t
}).then(res => res.data)
```
→ H5 还有一条**纯 HTTP 的桥入口** `GET /leo-bh5-bridge/<module>/<method>`。
（pk-node **未实现**这条路，只在 `HANDLERS` 里给了 `getNativeCommandList: []`。）

---

## 三、H5 实际调用的桥方法（全量 20 个 + 10 个走 `Zt` 的埋点类）

来源：全量扫描 `("method",{...},"module")` 形态与 `Zt/Pt/$t` 调用点。

| module | method | 调用文件 |
|---|---|---|
| `LeoSecure` | `requestConfig` | `request-legacy.CdI7tZrH.js`, `request-legacy.voS5CHjW.js` |
| `leo` | `getExerciseInfo` | `oral-pk-legacy.CoJN1ZvA.js` |
| `leo` | `getFeatureConfig` | `feature-legacy.C2Nasqum.js` |
| `leo` | `getOrionConfig` | `orion-legacy.vlj0o9i-.js` |
| `leo` | `getFireworkConfig` | `index-legacy.DqAYjRZL.js` |
| `leo` | `networkFailedManage` | `request-legacy.voS5CHjW.js` |
| `leo` | `setOnInteractivePopped` | `useMotivation-legacy.DdXBUx3h.js` |
| `leo` | `setForceBounceEnable` | `pk-legacy.BWN8ZR_k.js` |
| `leo` | `ShowMultiExpToolDialogIfNeeded` | `pk-legacy.BWN8ZR_k.js` |
| `leo` | `ShowPracticeDialogIfNeeded` | `pk-legacy.BWN8ZR_k.js` |
| `leo` | `getRatingPopupFrequency` / `showRatingPopup` | `useRatingPopup-legacy.R91T1cME.js` |
| `common` | `getWebViewInfo` | `index-legacy.CHYoHfC0.js` |
| `common` | `getUserInfo` | `index-legacy.CHYoHfC0.js` |
| `common` | `jsLoadComplete` | `index-legacy.CHYoHfC0.js` |
| `common` | `addFrog` / `refreshStateView` | `index-legacy.CHYoHfC0.js` |
| `common` | `setLeftButton` / `setOnVisibilityChange` / `setTitle` / `closeWebView` / `toast` / `login` | `index-legacy.CHYoHfC0.js` |
| — | `getBasicInfo` / `exitDialog` | `index-legacy.CHYoHfC0.js` |

### 关键语义（易踩）

- `networkFailedManage` → **返回非空 = 当失败**（`request-legacy` 里 `.then(e => e ? reject : resolve)`）→ 必须回 `''`。
- `showRatingPopup` → `null` = 不弹。
- `ShowPracticeDialogIfNeeded` → 是**查询**不是 setter，回 `{dialogNeedToShow:false}`。
- `setOnInteractivePopped` / `setLeftButton` / `setOnVisibilityChange` / `setForceBounceEnable` / `observeTabChange` / `refreshStateView` → **setter 语义，trigger 只能登记、绝不能回调**（否则等于替用户按键）。
- `requestConfig` → 把 URL 里的 `{client}` / `{device}` 换成 `api`，回 `{wrappedUrl}`。**缺它所有 `/leo-xxx/{client}/...` 全 404**。

---

## 四、每个按钮 → URL 全表

### 4.1 统一出口（`useNavigation-legacy.C-iCgWHr.js` 的 16 个导出）

**所有跳转**都拼 URL 后发 `openSchema`，schema 形如：
```
native://openWebView?url=<encodeURIComponent(url)>&<声明式参数...>
```

| 导出 | 目标 URL（原版逐字） | 声明式参数 |
|---|---|---|
| `gotoPkExercisePage(pointId, close, ?, peak)` | `${LEO_HOST}/bh5/leo-web-oral-pk/${d}.html?pointId=X&isFromInvite=..&exerciseType=..&triggerPeakMatch=1&jumpTime=<now>`<br>`d` = `oral-merge` \| `exercise`（由 feature `leoOralPKExerciseUseMerge` 决定，默认 false → **`exercise.html`**） | `keepScreenOn=true&hideNavigation=true&immerseStatusBar=true&targetModule=mathExercise&autoHideLoading=false&isFullScreen=true` |
| `gotoPeakMatchExercisePage` | 同上，末参 `peak=true` → 加 `&triggerPeakMatch=1` | 同上 |
| `gotoMultiPkExercisePage(pointId, close)` | `${LEO_HOST}/bh5/leo-web-oral-pk/exercise.html?pointId=X&isMultiPk=true&jumpTime=<now>` | 同上 |
| `gotoSchoolSeasonMatchPage(p, name, sid, close, qc, grade)` | `.../school-season-match.html?pointId=&pointName=&gameSessionId=[&questionCount=][&grade=]` | 同上 + `forcePortrait=true` |
| `gotoPropPkExercisePage(pointId, close, propsList)` | `.../item-oral.html?pointId=X&propsList=Y` | 同上 |
| `gotoPkResultPage(pkIdStr, challengeCode, final, isMultiPk, peak)` | `.../result.html?pkIdStr=X[&challengeCode=][&exerciseType=final][&isMultiPk=true][&triggerPeakMatch=1]`<br>**★ 不带 `isFromHistory`** | `hideNavigation=true&immerseStatusBar=true&autoHideLoading=false&isFullScreen=true` |
| `gotoMultiPkResultPage(battleId, ticket, trace, session, meta)` | `.../pk-activity-result.html?battleId=..&battleTicket=..&traceId=..&gameSessionId=..&lastExp=..&rankVersion=..&multiple=..&taskInfoKey=..&expMultiType=..&expToolItemMultiple=..&expToolItemExpireTime=..&pointCount=..` | 同上，`close:true` |
| `gotoPropPkResultPage(pkIdStr, rewind)` | `.../prop-result.html?pkIdStr=X[&opponentTimeRewind=1]` | 同上 |
| `gotoEnglishPkExercisePage(pointId)` | `.../english-words.html?pointId=X[&exerciseType=]` | 同上 |
| `gotoEnglishPkResultPage(pkIdStr, final)` | `.../result.html?subject=english&pkIdStr=X[&exerciseType=final]` | 同上 |
| `gotoEnglishEliPkResultPage(pkIdStr)` | `.../result.html?subject=englishEli&pkIdStr=X` | 同上 |
| `gotoEnglishEliPkPage(pointId, close)` | **`${location.origin}/bh5/leo-web-oral-pk/english-word-match.html?pointId=X`** | 同上 |
| `autoGotoTimeOverPage()` | `${LEO_HOST}/bh5/leo-web-math-exercise/timeover.html` | `autoHideLoading=true&hideNavigation=true&immerseStatusBar=true`（**3600s 定时器**） |
| `gotoPkResultHistoryPage(pkIdStr)` | `.../result.html?isFromHistory=true&pkIdStr=X` | `hideNavigation=true&immerseStatusBar=true&autoHideLoading=false` |
| `gotoRank()` | **`${location.origin}/bh5/leo-web-oral-pk/pk.html#/pk-rank`** | `hideNavigation=true&immerseStatusBar=true&autoHideLoading=true&targetModule=mathExercise` |
| `gotoSimpleInvitePage()` | **`${location.origin}/bh5/leo-web-oral-pk/invite-friend.html#/`** | `hideNavigation=true&immerseStatusBar=true&autoHideLoading=false&targetModule=mathExercise` |

> ⚠️ 注意 `location.origin` vs `LEO_HOST` 混用：`gotoRank` / `gotoSimpleInvitePage` / `gotoEnglishEliPkPage` / 诗词系列用的是 **`location.origin`**（同源），其余用 `LEO_HOST`（`https://xyks.yuanfudao.com`）。

### 4.2 首页 `pk.html` 的按钮（`pk-legacy.BWN8ZR_k.js`）

首页是 `pointList` × 卡片，每张卡片三个按钮：

| 按钮 DOM | 文案 | 点击处理 | 落到 |
|---|---|---|---|
| `.pk-btn` | `1v1PK`（有 8 人能力时）/ 否则 `开始PK` | `K(point, index, false)` | `gotoPkExercisePage(pointId, false)` |
| `.pk-btn.multi` | `8人PK` | `K(point, index, true)` | `gotoMultiPkExercisePage(pointId, false)` |
| `.peak-match-entry` | `巅峰对决`（带箭头图） | `K(point, index, false, true)` | `gotoPeakMatchExercisePage(pointId)` |

`K()` 内部流程（逐行）：
```
1. 登录门禁：if (!isLogin && !unloginPkEnable) → $showDialog({loginTitle:'登录后开始PK'}) + location.reload()
2. 埋点：$addFrog(isInExerciseTab ? '/click/exerciseHomepage/pkModule/start' : '/click/onlinePKpage/start',
        {module:'calculate', grade, mode, triggerPeakMatch})
3. 反沉迷：if (需弹 && isLogin) → $showDialog(ANTI_ADDICTION_DIALOG, {pk: 真正跳转})
4. 真正跳转 g()
```
> `isLogin` 来源 = `useUserInfo` ← 桥 `getUserInfo`。**没有真实 userId 会死循环 reload**。

### 4.3 其它入口（`pk-legacy` 内）

| 入口 | 条件 | 目标 |
|---|---|---|
| `SchoolSeasonEntry`（开学季横幅） | feature `leo.oral.pk.schoolSeason.entry` → `content.enable` | `${LEO_HOST}/bh5/leo-web-oral-pk/school-season.html` |
| `PoetryPkCard`（诗词） | `pointList[0].pointId` | `${location.origin}/bh5/leo-web-poem-pk/knowledge.html?pointId=X` |
| 诗词对局 `A()` | — | `${location.origin}/bh5/leo-web-poem-pk/exercise.html?pointId=X[&type=idiom]` |
| 英语单词卡 | — | `${location.origin}/bh5/leo-web-oral-pk/english-words.html?pointId=X&type=Y#/word-book` |
| 奖励弹窗「去查看」 | 奖品为头像框 | `${LEO_HOST}/bh5/leo-web-settings/avatar.html` |
| 金币 | — | `${window.location.origin}/bh5/leo-web-rank/gold.html#/shop` |
| Banner 轮播 `m(item)` | `goal` 含 `native:`/`leo:` | 透传 schema，`keypath` 累加进 `url=` |
| 头像点击 `r()` | — | 桥 `login` |

### 4.4 荣誉榜（`useMotivation-legacy.DdXBUx3h.js`）

```
${LEO_HOST}/bh5/leo-web-study-group/motivation-honor-roll.html
  ?fromType=<e>[&lastExp=][&rankVersion=][&multiple=][&taskInfoKey=]
  [&expMultiType=][&expToolItemMultiple=][&expToolItemExpireTime=][&pointCount=]
```
声明式参数固定为：`hideNavigation=true&immerseStatusBar=true&autoHideLoading=false&withTransitionAnimation=false`

**开关链**：
- `exerciseMotivation` ← feature `leo.fusion.honor.ranking.config` → `content.inUse`（**必须 false**，否则结算页「返回」变成「继续打卡」）
- `delayHonor` ← feature `leoOralPKExerciseDelayHonor`（`'true'` 才延迟）
- 进入前若 `leoExerciseTaskExp !== 'false'` → `preFetchTaskInfo()` → `setCacheData({key:'IncentiveTaskCache'})`（走 `vgo` module）
- `setOnInteractivePopped` 的 trigger 回调里才 `toFusionClockIn()`（`native://leo/tryShowFusionClockIn`）

---

## 五、比赛（对局）页面怎么进入 —— 完整链

```
① 用户打开 pk.html（入口 URL 由宿主给，见第六节）
② 首页 onMounted → getPkHome（GET /leo-game-pk/{client}/math/pk/home）+ getUserInfo 桥
   → 渲染 pointList 卡片（口算 / 诗词 / 英语 / 单词消消乐）
③ 用户点卡片「1v1PK」
④ K(point, idx, false)
   ├ 未登录 → 弹「登录后开始PK」+ location.reload()
   ├ 埋点 addFrog
   ├ 反沉迷检查（若需要）→ $showDialog(ANTI_ADDICTION_DIALOG, {pk})
   └ 跳转
⑤ gotoPkExercisePage(pointId, false)
   ├ feature 'leoOralPKExerciseUseMerge' → 'true'? 'oral-merge' : 'exercise'
   ├ 拼 URL： .../bh5/leo-web-oral-pk/exercise.html?pointId=X&isFromInvite=false
   │          [&exerciseType=][&triggerPeakMatch=1]&jumpTime=<Date.now()>
   └ openSchema(['native://openWebView?url=<enc>&keepScreenOn=true&...'])
⑥ 宿主接住 schema → 开新 WebView 容器（原版是原生 openWebView）
⑦ exercise.html 内：
   - GET /leo-game-pk/{client}/math/pk/match/v2（密文，走 dataDecrypt 桥）
   - 出题、答题、计时
   - 结束 → It() → saveLocalResult(localStorage '__local_exerciseResult')
   - → gotoPkResultPage(pkIdStr) → result.html?pkIdStr=X
⑧ result.html（isFromHistory=false 分支）：
   - 读 localStorage → POST /math/pk/submit（body = dataEncrypt 桥产物）
   - 「继续PK」按钮 → gotoPkExercisePage(pointId, true) → **直接开新一局**（不经过榜单）
```

> **`pk.html#/pk-rank` 是独立入口**，页面内**没有**「继续」按钮 —— 它不在对局循环里。

---

## 六、cookie 能力 —— 三个层次（原版 vs pk-node vs App）

### 6.1 H5 层（原版**从不碰** cookie）
- `axios.create({ withCredentials: true })`（`request-legacy.CdI7tZrH.js`）
- `XMLHttpRequest` 也一律 `withCredentials = true`（`index-legacy.CHYoHfC0.js`）
- `StorageUtil.createCookie/readCookie` 只用于 **`__local_*` 本地缓存**，不是业务态
- `index-legacy.ogXWEC7-.js` 的 `m()` 写 cookie 带 `domain=document.domain.split('.').slice(-2).join('.')` → 即 `yuanfudao.com`（**无前导点 = host-only**）

### 6.2 原版 App 层（cookie 真源）
- WebView 内 H5 请求 `https://xyks.yuanfudao.com/...` → 由 `CookieManager` 自动带
- 真机地面真值：12 条 cookie 的 `host_key` 全是 **`.yuanfudao.com`（带前导点）**
- 出站业务头另有 `x-shepherd-did` / `leo-client-trace-id` / `default-namespace-sw8`
- **sign** 由原生 `LeoSecure.calculateSign` 算，H5 自己不会算

### 6.3 pk-node 层（现有实现）
- `src/http.js` 的 **`CookieJar`**：`absorbSetCookie(setCookieList, requestHost)` 按**来源域名**吸收；`headerFor(host)` 按 `domainMatches` 出站 → **按 host 分区，同浏览器行为**
- 每个小猿账号一份 jar：`jobs.jarOf(leoId)`
- H5 请求被 hook 改写成 `/api/pk/h5/api?__t=<host>&leoAccountId=N`，Node 侧用**该账号的 jar** 发真请求
- **`proxyApi` 从不读 `req.headers.cookie`** → 身份**只由 `leoAccountId` 决定**
- 出站补 `_productId=631`、`_appId=6`、`version=3.140.1`（**覆盖** H5 用 UA 算出的 3.141.x，否则 417）+ sign + 风控头

### 6.4 App 层（cn.apixiaoyuan.app）
- `PkH5Proxy`（`core/oldsimian/PkH5Proxy.kt`）拦截 WebView 请求转发给内置 node
- **已知不一致**：`PkH5Proxy` 目前「非主域只借 cookie 原样转发」，与 pk-node「按 host 分区的 jar」不一致（见 2026-10-04 记忆）

---

## 七、pk-node 现状 vs 原版：差异清单

| # | 项 | 原版 | pk-node 现状 | 结论 |
|---|---|---|---|---|
| 1 | 跳转实现 | 原生 `openWebView` 开新 WebView | `location.href` 同窗口导航 | **有意为之**（浏览器 iframe 里必须这样） |
| 2 | `closeWebView` | 原生关当前层 | `history.back()`；`__PK_IN_APP` 时发 `leo://close` | 已按容器区分 ✓ |
| 3 | `/bh5/` 路由 | CDN 上真实存在 | 无 `/bh5/` 路由，靠 `toLocalH5()` 折算 | ✓（但换域名会漏） |
| 4 | `getNativeCommandList` | 原生回**真实能力表** | 回 `[]` | **缺口**：H5 拿不到能力表（不阻断） |
| 5 | `leo-bh5-bridge` HTTP 桥 | 原生/HTTP 双通道 | **未实现**（无路由） | **缺口** |
| 6 | `SolarWebViewV2` | 原生提供 | hook 里注册了别名 | ✓ |
| 7 | feature 开关 | orion 配置中心 | `FEATURE_CONFIG` 硬编码表 | 需按上游变更维护 |
| 8 | sign | 原生 LeoSecure | Node `sign.js` | ✓ |
| 9 | cookie | CookieManager（`.yuanfudao.com`） | 每账号 jar（按 host 分区） | ✓（App 侧待对齐） |

---

## 八、对齐检查清单（改代码前必看）

1. **`isFromHistory` 绝不能乱注入** —— 它决定结算页「提不提交」。
2. **`result.html` 跳转不带 `isFromHistory`**（`gotoPkResultPage` 逐字如此）。
3. **`gotoRank` / `gotoSimpleInvitePage` / `gotoEnglishEliPkPage` / 诗词页用 `location.origin`**，不是 `LEO_HOST`。
4. **声明式参数要逐字对齐**：`hideNavigation` / `immerseStatusBar` / `autoHideLoading` / `isFullScreen` / `targetModule` / `keepScreenOn` / `forcePortrait` / `withTransitionAnimation`。
5. **setter 类桥的 trigger 不能回调**。
6. **`networkFailedManage` 必须回 `''`**。
7. **新加 URL 参数必须同步进 `addLeoId()`**，否则下级页丢参。
8. **`leo-bh5-bridge` 与 `getNativeCommandList` 是当前两个明确缺口**。

---

## 九、分析产物索引

`/root/h5/analysis/`：

| 文件 | 内容 |
|---|---|
| `01-模板串URL.txt` | 全量模板串 URL（位置 + 原文） |
| `02-native-schema.txt` | 全量 `native://` schema（49 条） |
| `03-桥调用点.txt` | `("method",{...},"module")` 形态调用点 |
| `04-cookie.txt` | 全量 `withCredentials` / `document.cookie` 上下文 |
| `05-桥传输层.txt` | `CommonWebview` / `RNJsBridge` / `webkit` / `postMessage` 命中 |
| `06-模块API.txt` | 每模块 → API 路径映射 |
| `07-goto调用点.txt` | 全量 `goto*()` 调用点 |
| `09-pk-legacy-openWebView.txt` | 首页所有 `openWebView` 调用点上下文 |
| `10-按钮文案.txt` | 中文按钮文案 + 上下文 |
| `11-桥方法全量.txt` | 桥方法全量表 |
| `12-request模块全文.txt` | `request-legacy` 全文 |

复现脚本：`/root/h5/extract.py`、`extract2.py`、`extract3.py`
原始 bundle 副本：`/root/h5/leo-web-oral-pk_1789638371210/`、`/sdcard/h5dump2/`
