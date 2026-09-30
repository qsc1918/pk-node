# pk-node · 全页面流程链规格（照逆向原版，2026-09-30）

> 本文所有结论均**逐行读原版 H5 源码**得出，非猜测。路径：
> `/tmp/h5all/js/*.js`（leo-web-oral-pk 全量 71 模块）与 `/tmp/h5all/hr3/*.js`（荣誉榜）。

## 一、页面清单（导航目标，来自 `useNavigation-legacy.C-iCgWHr.js`）

| 导出函数 | 目标 URL | 说明 |
|---|---|---|
| `gotoPkExercisePage(p, close, ?, peak)` | `exercise.html` 或 `oral-merge.html`?pointId=/challengeCode= + isFromInvite + exerciseType + triggerPeakMatch + jumpTime | 对局页。走哪个 html 由 feature `leoOralPKExerciseUseMerge` 决定（false→exercise.html） |
| `gotoMultiPkExercisePage(pointId, close)` | `exercise.html?pointId=..&isMultiPk=true&jumpTime=..` | 8 人 PK |
| `gotoPkResultPage(pkIdStr, challengeCode, final, isMultiPk, peak)` | **`result.html?pkIdStr=X`**（★ **不带 isFromHistory**） | **对局结束后的结算页** |
| `gotoPkResultHistoryPage(pkIdStr)` | `result.html?isFromHistory=true&pkIdStr=X` | **查看历史战绩**（只读，不提交） |
| `gotoRank()` | `pk.html#/pk-rank` | PK 榜（榜单展示页，**无「继续」按钮**） |
| `gotoSimpleInvitePage()` | `invite-friend.html#/` | 好友挑战 |
| `gotoHonorRoll(...)`（useMotivation） | `.../leo-web-study-group/motivation-honor-roll.html?fromType=..` | 荣誉榜（另一个 CDN 目录） |
| `autoGotoTimeOverPage()` | `leo-web-math-exercise/timeover.html`（3600s 后） | 超时页 |
| `gotoSchoolSeasonMatchPage` / `gotoPropPkExercisePage` / `gotoEnglishPkExercisePage` / `gotoEnglishPkResultPage` / `gotoEnglishEliPkPage` / `gotoEnglishEliPkResultPage` / `gotoItemPkResultPage` / `gotoMultiPkResultPage` | 各自 html | 其它玩法 |

## 二、对局 → 结算 的完整提交链（`Oral-legacy` → `Result-legacy`）

```
对局页 Oral-legacy
  It()  ← 计时结束 ve(()=>{It()})  或  <AnswerSheet onFinishExercise={It}/>
   ├ Ke.value 幂等守卫
   ├ 前置：G.value.examVO 必须存在（来自 getPkExerciseQuestionV2）
   ├ y = {...examVO, questions:F.value, correctCnt:x, costTime, updatedTime}
   ├ k = {...y, examVO:y, userInfos}
   ├ be(k) = saveLocalResult(k)      → localStorage __local_exerciseResult（Base64）
   └ mergePage ? emit('gotoResult')
               : we(k.pkIdStr, ...) = gotoPkResultPage
                     → openWebView result.html?pkIdStr=X      ★ 无 isFromHistory

结算页 Result-legacy  loadData(he)
  ├ isFromHistory=true  → GET math/pk/history/detail
  │                       只填 examVO；correctCnt/selfWinCount/costTime **硬编码 0**
  │                       ★ 完全不提交
  └ isFromHistory=false → Kt(3,1000) 读 localStorage __local_exerciseResult
         ├ 空 → debug emptyLocalResult + T()（返回）
         └ 非空 → 调试打点 postResultData
                 → se(o) = postPkExerciseResult
                     → LeoSecure/dataEncrypt → PUT /leo-game-pk/{client}/math/pk/submit
                        (content-type: application/octet-stream)
                 → 成功：Zt() 清 localStorage + J.setItem(STORAGE_KEY_LAST_PK_ID)
                          + ae.value = p（真实成绩）
```

## 三、结算页按钮语义（`Result-legacy` setup 尾部）

| 变量 | 含义 |
|---|---|
| `c` = `showPkResult` | 是否已展示结果（`me().showPkResult`） |
| `u` = `isFromHistory` | 是否历史战绩 |
| `M` = `delayHonor` | 延迟展示荣誉榜（feature `leoOralPKExerciseDelayHonor`） |
| `F` = `exerciseMotivation` | feature `leo.fusion.honor.ranking.config.content.inUse` |
| `T` | 关闭/返回 |
| `Y` = `toFusionClockIn` | 走融合打卡（`native://leo/tryShowFusionClockIn`） |

**「返回」按钮 `ht`**：
```js
ht = () => (c.value || u())
  ? (M.value ? emit('onBackClick') : (F.value ? toFusionClockIn() : T()))
  : (c.value = true)
```
→ `inUse`（F）必须为 **false**，否则「返回」变成「继续打卡流程」。

**「继续PK / 再练一次 / 继续挑战」按钮文案 `_t`**：
```js
_t = isMultiPk ? '继续PK'
    : challengeCode ? '继续挑战'
    : pkResult===Victory ? '继续PK'
    : '再练一次'
```

**「继续」按钮 `ee`**：
```js
ee = () => {
  ...埋点 again...
  if (isMultiPk) { gotoMultiPkExercisePage(pointId, true) }
  else {
    c = challengeCode || examVO.pointId
    if (c) switch (subject) {
      'english'    → gotoEnglishPkExercisePage(c)
      'englishEli' → gotoEnglishEliPkPage(c, true)
      default      → mergePage ? emit('onRetryClick') : gotoPkExercisePage(c, true)
    }
  }
}
```
→ **「继续」= 直接开新一局**（`gotoPkExercisePage`），**不经过排行榜**。

## 四、结论：用户描述 vs 代码

用户描述的正常流程：
```
PK → 打完 → 打开排行榜 → 点继续 → 结算页面 → 点继续 → 下一局
```

代码实际：
```
PK → 打完 → **（结算页自动打开）** → 点「继续PK」 → 直接开新一局
                ↑ 排行榜（pk-rank）是**独立入口**，不在这条链里
```

**排行榜 `pk.html#/pk-rank`** 是榜单展示页（读 `rank/list`），页面内**没有「继续」按钮**；
荣誉榜 `motivation-honor-roll.html` 是另一个 CDN 页（`fromType` 参数区分来源）。

因此「对齐流程」的**正确做法不是插一个排行榜跳转**，而是：
- 保持 H5 原有的结算页按钮语义（返回 / 继续PK 都由 H5 自己处理）；
- 我们的 `autoNext` 在结算页**点 H5 自己的「继续PK」** → 触发 `ee()` → 开新一局；
- 不去人为插入排行榜/荣誉榜跳转。

## 五、桥方法全量对照（H5 调用 24 个 · pk-node 实现 48 个）

H5 实际调用的桥（全量扫描 `"method",{...},"module"` 形式）：

```
LeoSecure/dataDecrypt, LeoSecure/dataEncrypt, LeoSecure/requestConfig
MathExercise/recognize
leo/ShowMultiExpToolDialogIfNeeded, ShowPracticeDialogIfNeeded,
    addMergeableKlog, addUnloggedUserExerciseRecord, doShareAsImage,
    getDeviceInfo, getExerciseConfig, getExerciseInfo, getFeatureConfig,
    getFireworkConfig, getLocation, getOrionConfig, getRatingPopupFrequency,
    getUnloggedUserExerciseExperience, isAppStoreVersion, networkFailedManage,
    setBounceEnable, setForceBounceEnable, setOnInteractivePopped,
    showRatingPopup
```

2026-09-30 补齐 11 个此前会 `bridge-miss` 的（含 setter/查询语义差异）：
`setOnInteractivePopped`(setter·只登记) · `networkFailedManage`(回 '' 才 resolve) ·
`ShowMultiExpToolDialogIfNeeded` · `setBounceEnable` · `addUnloggedUserExerciseRecord` ·
`showRatingPopup` · `getRatingPopupFrequency`(回 null=不弹) · `isAppStoreVersion`(false) ·
`doShareAsImage` · `getLocation`({latitude,longitude}) ·
`getUnloggedUserExerciseExperience`({experience}) ·
并把 `ShowPracticeDialogIfNeeded` 从「setter」改为「查询」→ 回 `{dialogNeedToShow:false}`。

## 六、铁律（本项目已多次踩）

1. **协议参数不是样式开关**：`isFromHistory` 决定走不走提交分支，绝不能为「页面好看」而改。
2. **读分支要读全**：只读到 `J.getItem` 就断言「数据空」是抽样式误判（`ebc0451` 的教训）。
3. **setter 类的 trigger 绝不能回调**：`setLeftButton` / `setOnInteractivePopped` 等，
   一回调就等于「替用户操作」。
4. **未实现的桥必须回 `METHOD_NOT_SUPPORT` 并回调**，否则 H5 的 Promise 永久挂起。
5. 改完必跑 `node --check` + `node tools/check-inject.js`（本文档编写本次又抓到 1 次反引号）。
