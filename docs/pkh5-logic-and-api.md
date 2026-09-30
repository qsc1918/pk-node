# pkh5 全量逻辑与相关 API（2026-09-30 深挖）

> 来源：`leo.fbcontent.cn/bh5/leo-web-oral-pk/{pk,exercise,result}.html` 的 **71 个 JS 模块**（3.1MB）
> ＋ 运行期 hook 日志（`/tmp/pknode*.log`）＋ 真机 APK（MT MCP workspace `e4p9upae`）。
> 本文只写**读代码/读日志得到的事实**，不含猜测；推测处明确标注「推测」。

---

## 0. 页面与入口

| 页面 | 入口 bundle | 作用 |
|---|---|---|
| `pk.html` | `pk-legacy.BWN8ZR_k.js`（515KB） | PK 主页（路由 `home/pk-rank/pk-record`） |
| `exercise.html` | `exercise-legacy.CymkgeU.js` → 实际路由到 `index-legacy.Blmv9pEj.js` + `Oral-legacy` | 对局页 |
| `result.html` | `result-legacy.mInj4CmT.js` → `Result-legacy.DoeuGaGJ.js` | 结算页 |
| 荣誉榜 | 另一应用 `leo-web-study-group/motivation-honor-roll.html` | PK榜 |

三个页面都通过 `modulepreload` 复用 `index-legacy.CHYoHfC0.js`（桥调用封装）。

---

## 1. ★ 桥协议（权威，来自 `index-legacy.CHYoHfC0.js`）

```
调用： window[module].callNative(base64(JSON.stringify(payload)))
      payload = { method, params, trigger, jsCallBack?, ... }
回调： window[trigger](base64(JSON.stringify([err, ...data])))
```
- `module` 取值：`common` / `leo` / `LeoSecure` / `MathExercise`。
- **未知方法也必须回调**，否则 H5 的 Promise 永久挂起。
- **`trigger` 有两种语义**：
  - 查询类（`getUserInfo`/`getWebViewInfo`/`requestConfig`/`dataDecrypt`/`dataEncrypt`/`recognize`/`getFeatureConfig`）→ **必须回调**；
  - setter 类（`setLeftButton`/`setOnVisibilityChange`/`refreshStateView`/`setForceBounceEnable`/`observeTabChange`/`ShowPracticeDialogIfNeeded`/`hideNavigation`）→ **只登记，绝不回调**（回调等于替用户按键）。

### 1.1 桥方法使用频次（全 71 模块统计）

| 方法 | 次数 | 备注 |
|---|---|---|
| `loading` | 78 | UI |
| `addFrog` | 61 | 埋点 |
| `toast` | 57 | UI |
| **`hideNavigation`** | **28** | 影响原生导航栏 |
| `openWebView` | 27 | 页面跳转 |
| `callNative` | 7 | 通用入口 |
| `login` | 6 | 唤起登录 |
| `refreshStateView` | 4 | setter |
| `getAuthContext` | 3 | |
| `setOnVisibilityChange` / `setLeftButton` / `setForceBounceEnable` / `setBounceEnable` / `requestConfig` / `recognize` / `getWebViewInfo` / `getDeviceInfo` / `getDeviceId` | 2 | |
| `setTitle` / `sendEventToNative` / `openSchema` / `observeTabChange` / `jsLoadComplete` / `getUserInfo` / `getSolarContext` / `getOrionConfig` / `getImmerseStatusBarHeight` / `getFeatureConfig` / `dataEncrypt` / `dataDecrypt` / `closeWebView` / `addMergeableKlog` / `ShowPracticeDialogIfNeeded` | 1 | |

---

## 2. ★★ 功能开关（feature flag）—— 当前最大的系统性坑

`feature-legacy.C2Nasqum.js`（全文只有 ~1KB，逻辑完整）：

```js
export g(key, defaultValue, forceUpdate) {
  if (isLocal()) return Promise.resolve(defaultValue);   // ← 本地开发直接默认值
  return native(key, forceUpdate).then(v => v == null ? http(key, defaultValue) : v);
}
// ① 原生优先（能力判定 version >= 3.36.0）
var native = (k, fu) => new Promise(res => {
  hasCap() && versionGE('3.36.0')
    ? callNative('getFeatureConfig', { featureKey: k, forceUpdate: fu,
        trigger: (err, v) => res(err ? null : v) }, 'leo')
    : res(null);
});
// ② HTTP 兜底：POST {ORION_HOST}/orion-config-center/api/feature-config  body {bizKey}
var http = (k, dft) => httpPost(ORION_HOST + '/orion-config-center/api/feature-config', { bizKey: k })
  .then(r => r && r.data && r.data.data ? r.data.data[k] : dft)
  .catch(() => dft);                                    // ← 出错一律默认值
```

`ORION_HOST` 来自 `Utils-legacy.Bu69Mvnu.js` 的导出 `S`：
`//xyst.yuanfudao.com`（`.biz` 域时为 `//xyst.yuanfudao.biz`）。

### 已知被这个开关控制的点（读代码得到的调用）

| featureKey | 位置 | 影响 |
|---|---|---|
| `leo.unlogin.pk` | `pk-legacy` / `useHomeModel` 的 `unloginPkEnable` | 未登录 PK 入口 |
| `leoOralPKExerciseUseMerge` | `index-legacy.CHYoHfC0.js` | 对局页用 `oral-merge.html` 还是 `exercise.html` |
| `leo.fusion.honor.ranking.config` | `getOrionConfig` | 荣誉榜渲染 |
| `leo.pk.matching.waiting.text` | `getOrionConfig` | 匹配等待文案 |
| `leo-bh5/...` | 多个 | |

### 实测结论（本项目环境）

| 路径 | 结果 |
|---|---|
| 桥 `getFeatureConfig` | **可用**（我们自己实现的），**但需要真实值**，否则 H5 拿到 `undefined` → 走默认 |
| `POST xyst.yuanfudao.com/orion-config-center/api/feature-config` | **404** |
| `POST oapi.yuanfudao.com/...` | 404 |
| `POST xyks.yuanfudao.com/...` | 404 |

⇒ 我们环境里功能开关**必然降级为默认值**，这是「控件减少 / 榜单异常」类问题的系统性根因之一。
**正解**：桥 `getFeatureConfig` 不能返回空，要返回与真机一致的配置（可从真机抓包/或按需硬编码已知 key）。

---

## 3. ★★ 另一处隐蔽兜底：`leo-bh5-bridge` HTTP 桥

`Utils-legacy.js` 里导出的 `r`：

```js
export r = (name, params, module, baseURL) => httpGet(
  'https://xyks.yuanfudao.com/leo-bh5-bridge/' + (module || 'common') + '/' + name,
  { baseURL: 'https://xyks.yuanfudao.com', params });
```

⇒ H5 **保留了「没有原生桥时用 HTTP 桥」的降级路径**。
实测：`GET /leo-bh5-bridge/common/getUserInfo` → **404**（服务端未开放）。
**推测**：该路径只在特定版本/白名单可用；若能打通，可大幅减少我们自实现的桥。

---

## 4. API 全量清单（77 条，按域分组）

### 4.1 PK 主域（`/leo-game-pk/{client}/`，client=`api`）

| 方法 | 路径 | 调用方模块 |
|---|---|---|
| GET | `math/pk/home?grade=` | `index-legacy.DqAYjRZL.js` |
| GET | `math/pk/history?cursorTime&limit=20` | 同上 / `dialog` |
| GET | `math/pk/achievement?userId&grade` | `index-legacy.DqAYjRZL.js` |
| GET | `game/rank?schoolId&region&biz&country&lat&lng` | 同上 |
| GET | `english/pk/home` / `poetry/pk/home` | 同上 |
| **POST** | **`math/pk/match/v2?pointId&triggerPeakMatch`** | `exercise-legacy`（**加密响应**） |
| PUT | `math/pk/submit`（octet-stream，**需 dataEncrypt**） | `exercise-legacy` |
| POST | `math/pk/multi/submit` | `exercise-legacy` |
| POST | `english/pk/submit` / `final/pk/submit/{math,english}` / `word/eliminate/submit` | `exercise-legacy` |
| GET | `math/pk/history/detail?pkIdStr=` | `exercise-legacy` |
| POST | `math/pk/reward/claim` | `exercise-legacy` |
| POST | `pk/pros/use`、`pk/login/sync` | `exercise-legacy` |
| GET | `math/challenge/start?pkIdStr=` | `index-legacy.DqAYjRZL.js`（分享图） |
| GET | `math/challenge/info?challengeCode=` / `history` / `history/detail` | `dialog-legacy` |
| GET | `math/pk/props/home` | `CommonMask-legacy` |
| GET | `api/game/homepage` | `index-legacy.DqAYjRZL.js`（诗词） |

### 4.2 其它域

| 域 | 路径 | 调用方 |
|---|---|---|
| `leo-star` | `exercise/rank/pk/rate?ytkUserId=0&rankId=0`（**代码里写死 0**） | `index-legacy.DqAYjRZL.js` |
| `leo-star` | `exercise/rank/list?rankVersion=` | 荣誉榜 |
| `leo-star` | `exercise/rank/pre-fetch`、`exercise/task/home` | `useMotivation-legacy` |
| `leo-star` | `anti-addiction` | `useHomeModel`（防沉迷） |
| `leo-activity` | `backpack`、`activity/pk/daily/award`(+`/batch`)、`activity/pk/sign-act/{status,claim}` | `pk-legacy` / `CommonMask` |
| `leo-profile` | `api/user-infos/context` | `index-legacy.ogXWEC7-.js`（**ytkUserId 来源**） |
| `leo-reward` | `points/type/41`、`points/type/33` | `Result-legacy` |
| `solar-vip` | `api/users/self` | `index-legacy.ogXWEC7-.js` |
| `orion-config-center` | `api/feature-config`（POST `bizKey`） | `feature-legacy` |
| `oapi` | （`ORION_V2` 备用域） | `Utils-legacy` |

---

## 5. 主页状态模型（`useHomeModel-legacy.Bd8rSiW2.js`）

```js
isLogin    = ref(false)   // initUserInfo 成功才 true
userId     = ref(-1)
userGrade  = ref(ONE)
homeData   = ref({ baseUserInfoVO, capacity, monthWinCount, nextTitleTarget,
                    pointList, title, totalWinCount, weekWinCount, period, userTag })

initUserInfo()  →  fetchUserInfo()  →  { userId, gradeId }
initExerciseInfo() → 若 isLogin 假 且无本地 grade → getExerciseInfo()
initHomeData()  →  GET math/pk/home?grade=
unloginPkEnable → feature('leo.unlogin.pk') 默认 false   // 未登录 PK 开关
checkIfShowIndulgeDialog() → 防沉迷：GET anti-addiction，配合 localStorage
                             anti-addiction-trigger-times / -last-exercise-time
```

`grade` 来源优先级：localStorage `oral-pk-grade` > `fetchUserInfo().gradeId` > `getExerciseInfo()`。

### 实测：主页控件是**完整**的

```
三年级 / 头像+昵称 / 口算大侠 / 53 / 100% / 背包 / 奖励 / 领奖励 /
口算PK / PK榜 / 1v1PK / 8人PK / 诗词PK / PK榜 / 开始PK / 单词PK / PK榜 / 开始PK / 更多模式，敬请期待哦
```

---

## 6. 对局/提交链路（`exercise-legacy` + `Oral-legacy`）

```
1. 出题  POST /leo-game-pk/{client}/math/pk/match/v2?pointId=&triggerPeakMatch=0   (加密响应)
2. 答题  画板 canvas → MathExercise.recognize({strokes, keypointId, expectedResult, startTime})
         → 桥回「识别出的答案字符串」，H5 用 answers.includes() 比对
3. 提交  postPkExerciseResult = n(明文对象).then(b => PUT math/pk/submit  body=octet-stream)
         n = 明文 → 桥 LeoSecure.dataEncrypt({base64, trigger}) → Uint8Array(result)
4. 结算  Oral-legacy It(): 算 correctCnt → gotoPkResultPage(pkIdStr) → openWebView(result.html)
         紧接着 closeWebView() 关掉对局页自己
```

`getPkExerciseResult` = `GET math/pk/history/detail?pkIdStr=`（结算数据源）。

### 加解密（已逐字节验证）

```
密文 --keystream XOR--> gzip --gunzip--> 明文 JSON
明文 JSON --gzip(level6,mtime0)--> keystream XOR --> 密文
```
`libContentEncoder.so`（arm64，298144B，**只导出 `JNI_OnLoad`**，业务函数动态注册；imports 无密码学原语 → 坐实固定密钥流 XOR）。

---

## 7. 结算页（`Result-legacy`）

```js
ve = () => query.isFromHistory;
he():   ve() ? getPkExerciseResult(pkIdStr)   // → GET history/detail  ✅
              : getLocalResult()              // → localStorage 'exerciseResult'（对局页写入）
继续PK onClick ee() = () => {
  var c = challengeCode || S.value.examVO.pointId;   // S.value = 结算数据
  if (c) switch(subject) { ...: gotoPkExercisePage(c, true) }
}
```
⇒ **必须带 `isFromHistory=true`**，否则走 localStorage 分支（我们不经真机的存值顺序 → 空 → 0NaN）。

---

## 8. 当前已知问题与正解方向

| # | 问题 | 根因（已实证） | 方向 |
|---|---|---|---|
| 1 | 功能开关全降级 | orion HTTP 404；桥 `getFeatureConfig` 返回空 | 桥返回真实配置（抓真机） |
| 2 | 匹配「胜 0 场」 | 对局从未提交（`dataEncrypt` 曾空实现）；现已修 | 已修，待实测 |
| 3 | 荣誉榜空 | 待查（`rank/list` 实际返回了真实数据） | 查荣誉榜页自身逻辑 |
| 4 | `rank/pk/rate?ytkUserId=0` | H5 **代码写死 0**，非 bug | 忽略 |
| 5 | `leo-bh5-bridge` 全 404 | 服务端未开放 | 观祭/不依赖 |

---

## 9. 工具

| 工具 | 用途 |
|---|---|
| `tools/h5-map.js` | 从 `/tmp/h5all/js` 生成「模块 → API/桥」映射 |
| `tools/mt-mcp.js` | 访问 **8791 `/mcp`**（MT APK MCP）：`node tools/mt-mcp.js <tool> '<json>'`，`tools` 子命令列工具 |
| `tools/check-inject.js` | 注入脚本门禁（反引号/转义/语法/沙箱/桥协议/渲染检查） |
| `node --check` | 每次改完必跑（本轮已抓到 1 次反引号事故） |
