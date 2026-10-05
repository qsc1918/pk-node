#!/usr/bin/env node
'use strict';
/**
 * 导出「内置 node 工作区」zip —— 给 cn.apixiaoyuan.app 的 assets 用。
 *
 * ## 用途
 *
 * 老挂（cn.apixiaoyuan.app）内置了一份 Android 版 node（`jniLibs/arm64-v8a/libnode.so`），
 * 在 App 私有目录里跑 **pk-node 本体**，再由 WebView 访问 `http://127.0.0.1:8792`。
 * 本脚本产出「pk-node 本体」那一份 zip，App 首次启动时解压到 `filesDir/pk-node/`。
 *
 * ## 为什么不复用 make-release.js 的 zip
 *
 * 那个 zip 是**给人用的免安装包**，含 `start.sh` / `start.bat` / `docs/` / `tools/`
 * （几十个开发脚本）、还有 37MB 的 `cloudflared` 二进制（其实已被 NEVER 排除）。
 * 内置到 APK 里只需要**跑服务的最小集**，多了纯属浪费体积与解压时间：
 *
 *   | 项 | 免安装包 | 本工作区 |
 *   |---|---|---|
 *   | 体积 | ~1.0 MB | ~2.6 MB |
 *   | 文件数 | 100+ | 26 |
 *   | 启动脚本 | start.sh/start.bat | 无（App 直接 exec libnode.so） |
 *   | 文档/工具 | 全带 | 全不带 |
 *
 * 说明：体积反而更大是因为免安装包**不含** `lre.so`/`lre_pk.so` 之外的 arm64 库，
 * 而这里必须带上那两个 0.9MB 的签名数据（纯 JS 模拟器要读它）。
 *
 * ## 为什么 bin/native 只放两个 .so
 *
 * `lre.so` / `lre_pk.so` 是**纯数据**——被 `src/lre-emu.js` 逐条读机器码做模拟，
 * **从不执行**。所以它们能安全地放在 App 私有目录（W^X 只限制「执行」，不限制「读」）。
 * 其余 arm64 库（linker64 / libc.so / libContentEncoder_patched.so …）
 * 是给 `spawnSync(linker64, …)` 用的，在 App 内既跑不了也不需要（sign 已是纯 JS）。
 *
 * ## 用法
 *
 * ```sh
 * node tools/export-app-workspace.js                       # → dist/pk-node-workspace.zip
 * node tools/export-app-workspace.js --out /path/to/assets # → 指定文件路径
 * ```
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

/** 默认输出路径。 */
const DEFAULT_OUT = path.join(ROOT, 'dist', 'pk-node-workspace.zip');

/**
 * 工作区文件清单（相对仓库根）。
 *
 * ⚠️ 这份清单必须与 `server.js` 的 require 链对齐 —— 少一个文件，
 * App 里启动就会 MODULE_NOT_FOUND，而**构建期发现不了**（只有真机才暴露）。
 * 所以下面有一条「静态检查」：把 `server.js` 里 `require('./...')` 的路径都提取出来，
 * 逐个确认在工作区里存在。
 */
const INCLUDE = [
  'package.json',              // server.js 会读 version
  'server.js',                 // 服务入口
  'src',                       // 全部业务模块（含 lre-insns*.js 指令表，共 ~700KB）
  'public',                    // ★ 管理后台网页（index.html / app.js / style.css）
  'bin/keystream.bin',         // 纯 JS 内容编码器的密钥流（128KB），必需
  'bin/native/lre.so',         // 练习版 sign 模拟的机器码数据（不执行）
  'bin/native/lre_pk.so',      // PK 版 sign 模拟的机器码数据（不执行）
  // ★ 2026-10-05：**cloudflared 不再走这里**。
  //   原方案（bin/cloudflared.xz → App 解压到 files/ → chmod 755）在 Android 上跑不起来：
  //   SELinux 下 files/ 的标签是 app_data_file，**App 自己不能执行它**
  //   （真机实测 spawn → EACCES）。现改为打进 jniLibs
  //   （`jniLibs/arm64-v8a/libcloudflared.so`）—— 安装器把它解到 nativeLibraryDir，
  //   那里是 apk_data_file，可执行（内置 node 就是这么跑的）。
];

/**
 * ★★ 2026-10-05：cloudflared 的交付方式从「预压进工作区」改为「进 jniLibs」。
 *
 * # 为什么改（真机实测，不是推测）
 *
 * 原方案：把 cloudflared 用 xz 预压，App 首启解开成 `files/pk-node/bin/cloudflared`。
 * 真机报错：
 *
 * ```
 * 启动 cloudflared 失败：spawn /data/data/.../files/pk-node/bin/cloudflared EACCES
 * ```
 *
 * **根因是 SELinux，不是权限位**（chmod 755 也没用）：
 *
 *   | 位置 | SELinux 标签 | App 能执行？ |
 *   |---|---|---|
 *   | `files/`（应用私有目录） | `app_data_file` | ❌ 不能（实测用 runcon 模拟 untrusted_app 也是 Permission denied） |
 *   | `nativeLibraryDir`（`/data/app/.../lib/arm64`） | `apk_data_file` | ✅ 能（内置 node 就是这么跑的） |
 *
 * Android 10+ 的 W^X 就是这么设计的：**只有 APK 自带的原生库才能执行**。
 * 所以参照 libnode.so 的做法，把 cloudflared 改名成 `libcloudflared.so`
 * 放进 `app/src/main/jniLibs/arm64-v8a/`。
 *
 * # 代价（如实说明，比原方案大）
 *
 *   | 方案 | APK 增量 |
 *   |---|---|
 *   | xz 预压进工作区 zip（已废） | 14.77 MB |
 *   | **进 jniLibs（现方案）** | **约 37.7 MB**（未压；APK 里会 DEFLATE，实际增量看 AGP） |
 *
 * 多出来的体积是“能跑”的必要代价 —— xz 方案省了体积但根本执行不了。
 *
 * # 谁负责找到它
 *
 * `pk-node/src/config.js` 的 `resolveCloudflaredPath()`：
 * 优先用 `PK_NATIVE_LIB_DIR/libcloudflared.so`（App 传入），
 * 再回落到 `bin/cloudflared`（开发环境）。
 */
/**
 * ★ 2026-10-03 事故：`public` 曾**不在**上面这份清单里。
 *
 * 后果（真机症状）：App 里打开「pk-node 管理后台」显示 **「未找到」**。
 * 链路是 `server.js` 的 `serveStatic()`：
 *
 * ```js
 * const PUBLIC_DIR = path.join(config.root, 'public');   // server.js:25
 * if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return sendText(res, 404, '未找到');
 * ```
 *
 * 工作区里没有 `public/` → `index.html` 不存在 → 对 `/` 的请求稳定返回
 * `404 未找到`。**服务本身是好的**（`/api/auth/me` 200、H5 也正常），
 * 所以只看「服务起没起来」是发现不了的。
 *
 * 为什么之前的 `checkRequires()` 没抓到：它只扫 `require('./...')` 的
 * **JS 模块**依赖 —— 而 `public/` 是**静态资源**，JS 里根本不会 require 它。
 * 所以这次同时补了一条 `checkStatic()`（见下）专门盯这类漏项。 */

/**
 * 永不入包。
 *
 * ⚠️ 这里**不能**写 `src/services` —— 它是 `server.js` 的直接依赖
 * （auth / leo-accounts / login 三个模块），排除掉 App 里必然 MODULE_NOT_FOUND。
 * 这个坑正是被下面 `checkRequires()` 抓出来的（第一次跑就在这里报错）。
 *
 * 保留的理由：将来若加入 `src/views`（模板）、`src/routes`（无文件）之类
 * 纯服务端渲染资源，可以在这里显式排除。
 */
const NEVER = [
  'src/views',                 // 服务端模板（当前为空目录，walk 本就不会产出文件）
];

/**
 * 静态资源门禁：`server.js` 里 `path.join(<任意>, '<名字>')` 形式引用的目录/文件，
 * 必须在工作区里真的存在。
 *
 * 存在的理由就是上面 `public` 那次事故 —— `checkRequires()` 只看 JS 依赖，
 * 而静态目录（网页 UI！）是它看不见的盲区。
 */
const STATIC_DIRS = [
  'public',                    // serveStatic 的根（管理后台网页）
];

function checkStatic(files) {
  const problems = [];
  const seen = new Set(files);
  for (const d of STATIC_DIRS) {
    const present = files.some((f) => f === d || f.startsWith(d + '/'));
    if (!present) {
      problems.push('静态目录缺失：' + d + '（server.js 会从这里读文件，缺了就是 404）');
      continue;
    }
    // 目录在还不够 —— `public/index.html` 是 `/` 的入口，缺了照样「未找到」。
    if (d === 'public' && !seen.has('public/index.html')) {
      problems.push('缺少 public/index.html —— 访问 / 会直接 404「未找到」');
    }
  }
  return problems;
}

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(abs).sort()) walk(path.join(rel, e), out);
  } else if (st.isFile()) {
    out.push(rel.split(path.sep).join('/'));
  }
}

function collect() {
  const files = [];
  for (const rel of INCLUDE) walk(rel, files);
  return files.filter((f) => !NEVER.some((n) => f === n || f.startsWith(n + '/')));
}

/**
 * 静态检查：`server.js` 里所有相对 require 的目标，必须在工作区清单里存在。
 *
 * 这是**构建期**能抓到「漏拷文件」的唯一手段（真机才会暴露 MODULE_NOT_FOUND）。
 */
function checkRequires(files) {
  const problems = [];
  const seen = new Set(files);
  const scan = (rel) => {
    const abs = path.join(ROOT, rel);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { return; }
    const re = /require\(['"](\.[^'"]+)['"]\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1];
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel.split(path.sep).join('/')), spec),
      );
      // 允许省略 .js / 目录下 index.js（Node 解析规则）
      const candidates = [resolved, resolved + '.js', resolved + '/index.js', resolved + '.json'];
      if (!candidates.some((c) => seen.has(c))) {
        problems.push(rel + ' 需要 ' + spec + '（解析为 ' + candidates.join(' | ') + '）');
      }
    }
  };
  // 只扫 manifest 内的 js（含 server.js）
  for (const f of files) if (f.endsWith('.js')) scan(f.replace(/\//g, path.sep));
  return problems;
}

function human(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

/** 用 python3 的 zipfile 打包（与 make-release.js 同法，保证确定性、可复现）。 */
function zip(srcRoot, files, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const py = `
import os, sys, zipfile
root, dst = sys.argv[1], sys.argv[2]
rels = sys.argv[3:]
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for rel in rels:
        src = os.path.join(root, rel)
        zi = zipfile.ZipInfo(rel, date_time=(2026, 1, 1, 0, 0, 0))
        # ★ 2026-10-04：.xz 已经是 xz 压过的，再 deflate 没收益（还多花时间），
        #   直接 STORE；其余文件照旧 DEFLATE。
        zi.compress_type = zipfile.ZIP_STORED if rel.endswith('.xz') else zipfile.ZIP_DEFLATED
        zi.external_attr = (0o755 if rel.endswith('cloudflared.xz') else 0o644) << 16
        with open(src, 'rb') as f:
            z.writestr(zi, f.read())
print('zipped', dst)
`;
  const r = spawnSync('python3', ['-c', py, srcRoot, zipPath, ...files], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('zip 失败：' + (r.stderr || r.stdout));
}

function main() {
  const argv = process.argv.slice(2);
  let out = DEFAULT_OUT;
  const i = argv.indexOf('--out');
  if (i >= 0 && argv[i + 1]) out = path.resolve(argv[i + 1]);

  const files = collect();
  console.log('== 内置 node 工作区（pk-node ' + VERSION + '）==');
  console.log('  文件数：' + files.length);

  const problems = checkRequires(files);
  if (problems.length) {
    console.error('\n✗ require 链不完整（App 上会 MODULE_NOT_FOUND）：');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  require 链：OK');

  // ★ 2026-10-03 新增：静态资源门禁（`public` 那次事故的补丁）。
  const staticProblems = checkStatic(files);
  if (staticProblems.length) {
    console.error('\n✗ 静态资源不完整（App 上会 404「未找到」）：');
    for (const p of staticProblems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('  静态资源：OK');

  let raw = 0;
  for (const f of files) raw += fs.statSync(path.join(ROOT, f)).size;
  console.log('  原始体积：' + human(raw));

  // 体积门禁：内置到 APK 里，超了会明显拖累包体，必须显式确认。
  // ★ 2026-10-04：5 MB → **20 MB**。
  //
  // 原 5 MB 是「防误入大文件」的保护。现在有意加入了 cloudflared.xz（14.77 MB）
  // —— 它是「启动穿透」功能的必需品（用户报告 App 内点穿透报「未找到
  // cloudflared」）。所以把上限提到 20 MB：既能容纳 cloudflared，
  // 又能继续拦住「不小心把别的几十 MB 东西拷进来」这类事故。
  const LIMIT = 20 * 1024 * 1024;
  if (raw > LIMIT) {
    console.error('\n✗ 工作区超过 ' + human(LIMIT) + '（' + human(raw) + '）—— 请核实是否误入大文件');
    process.exit(1);
  }

  zip(ROOT, files, out);
  const zsize = fs.statSync(out).size;
  console.log('  zip   ：' + path.relative(ROOT, out) + '  ' + human(zsize));
  console.log('\n完成。把它放到 App 的 assets 里：');
  console.log('  cp ' + path.relative(ROOT, out) +
    ' /root/cn.apixiaoyuan.app/app/src/main/assets/pk-node-workspace.zip');
}

main();
