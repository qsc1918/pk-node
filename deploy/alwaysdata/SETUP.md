# 把 pk-node 部署到 alwaysdata（免费版）

> 为什么选它：**永久免费 + 1GB 持久磁盘（SQLite 不会丢）+ 国内可达 + 空闲不强制休眠**。
>
> 实测排除：`workers.dev` 国内 000；Render 免费版无持久磁盘且 15 分钟休眠；
> Zeabur/Sealos 免费版不含云资源；Vercel/Fly/Koyeb/HF 国内 000。

---

## 已完成的准备工作（我这边）

| 事项 | 状态 |
|---|---|
| 确认 x86_64 不需要任何 arm64 二进制 | ✅ 删掉全部 arm64 工具链后 selftest 全通过 |
| 适配平台注入的 `HOST` / `PORT` | ✅ `bin/start.js` 已改（平台指定端口就原样监听） |
| 打包脚本 | ✅ `deploy/alwaysdata/make-package.sh` → 912KB |
| 部署脚本（上传 + 解压 + 自检） | ✅ `deploy/alwaysdata/deploy.sh` |
| 干净目录实测启动 | ✅ 首页 200 / 登录成功 / 编码与 sign 自检 OK |

**关键验证**（这是 x86 能跑的前提）：
```
[pk-node] 编码/sign 自检：OK（sign 样例 7c69c467746028362e44ef38bc850bac）
[pk-node] sign 公式自校验：OK
native.detail: 编码（纯 JS）+ sign（纯 JS 模拟 arm64）均可用，无需 arm64 原生资产
```
原因：`bin/native/lre.so` 是**纯数据**（arm64 机器码），由 `src/lre-emu.js`（纯 JS 模拟器）
解释执行来生成 T；内容编码是固定密钥流 XOR（`bin/keystream.bin`）。
两者都不需要 CPU 原生支持，实测与真机抓包**逐字节一致**。

---

## 需要你做的（约 10 分钟）

### 第 1 步：注册 alwaysdata

打开 https://www.alwaysdata.com/en/ 注册免费版（Free，0€/月，永久）。
注册时选的 **account 名**很重要（下面会用到），比如 `sxd91`。

### 第 2 步：告诉我 account 名

我拿到名字后会跑：

```bash
ALWAYSDATA_PASSWORD='你的密码' bash deploy/alwaysdata/deploy.sh <account>
```

> 也可以不用密码：你在面板 `Remote access > SSH/SFTP` 里加一个 SSH 公钥，
> 我把公钥给你，或者你把私钥放我这。

### 第 3 步：在面板建 Node.js 站点

`Web > Sites > Add a site`：

| 字段 | 填什么 |
|---|---|
| Name | `pk-node` |
| Addresses | `<account>.alwaysdata.net` |
| Type | **Node.js** |
| Command | `node /home/<account>/www/pk-node/bin/start.js` |
| Working directory | `/home/<account>/www/pk-node` |

> 站点会自动注入 `HOST` + `PORT`，`bin/start.js` 已经会读它们，不用手填。

### 第 4 步：关掉「空闲休眠」

在这个站点的 `Advanced > Idle time`，**拉到最大值**。
不关的话空闲一段时间会被停掉，再访问要等它冷启动（和 Render 那个毛病一样）。

### 第 5 步：登录并改密码

打开 `https://<account>.alwaysdata.net`：

- 默认账号 **admin / admin** → **立刻改密码**（右上角）
- 然后「小猿账号」页导入你的 Cookie

---

## 数据与安全

- SQLite 落在 `~/www/pk-node/data/pk-node.sqlite`，属于**持久磁盘**，重新部署不会被删
  （`deploy.sh` 会先把 `data/` 挪走再解压、然后还原）。
- 小猿 cookie 在库里是 **AES-256-GCM 加密**的，密钥 `data/secret.key`（0600）。
  备份时**这两个要一起备**，只拿 db 文件解不开登录态。
- 每 3 天有自动备份（免费版包含）。

## 已知限制（如实说明）

| 限制 | 影响 | 对策 |
|---|---|---|
| 256MB RAM | 跑刷局任务够用；同时开很多任务可能吃紧 | 任务别一次开太多 |
| 只有 1 个 Node 站点（免费版） | 只能跑这一个应用 | 够用 |
| 空闲会被停（需手动关） | 冷启动约数秒 | 第 4 步已解决 |
| 出题频控 ~61.6s/账号 | 不是平台问题，是小猿服务端限制 | 每轮间隔设 >61.6s |

## 排错

| 现象 | 看哪里 |
|---|---|
| 502 / 页面打不开 | `/home/<account>/admin/logs/sites/` 下的站点日志 |
| Node 版本不对 | 面板 `Environment > Node.js` 选 22 或 24（本应用要 ≥22，因为用了 `node:sqlite`） |
| 想重启 | 面板该站点的 `Restart`，或 `Advanced > Processes` 里结束进程 |
| 自检失败 | SSH 上去跑 `cd ~/www/pk-node; node bin/selftest.js` |