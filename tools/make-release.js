#!/usr/bin/env node
'use strict';
/**
 * 打「免安装」发布包（release assets）。
 *
 * 用法：
 *   node tools/make-release.js            # → dist/pk-node-<version>.zip
 *   node tools/make-release.js --dir      # → dist/pk-node-<version>/（不解压，方便检查）
 *
 * ## 打包原则
 *
 * **只装「跑起来需要的 + 源码 + 文档」**，把运行时会变的东西全部排除：
 *
 * | 排除项 | 原因 |
 * |---|---|
 * | `data/` | 运行时数据库，**含明文 cookie**，绝不能进发布包 |
 * | `bin/cloudflared` | 36 MB 穿透客户端，用 `bin/get-cloudflared.sh` 按需下载 |
 * | `bin/native/` | arm64 Android 原生库。**当前已不需要**：内容编码是纯 JS，sign 默认关闭。带上它只会让包大 7.5 MB |
 * | `.git/` `dist/` `node_modules/` | 无关 |
 *
 * 打包后会自动**解包到临时目录跑一遍自检 + 起服务验证**，通过了才留下 zip。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const NAME = `pk-node-${VERSION}`;
const DIST = path.join(ROOT, 'dist');
const ZIPPATH = path.join(DIST, NAME + '.zip');
const OUTDIR = path.join(DIST, NAME);

/** 要打进包的文件/目录（相对仓库根）。目录会递归展开。 */
const INCLUDE = [
  'package.json',
  'README.md',
  'DISCLAIMER.md',
  'LICENSE',
  'start.bat',
  'start.sh',
  'server.js',
  'src',
  'bin/pick-port.js',
  'bin/reset-admin.js',
  'bin/selftest.js',
  'bin/keystream.bin',        // ★ 纯 JS 内容编码器的密钥流，必需
  'bin/get-cloudflared.sh',
  'public',
  'docs',
  'tools',
];

/** 永不打包（就算 INCLUDE 里手滑写进来也要挡住）。 */
const NEVER = [
  'data',
  'bin/native',
  'bin/cloudflared',
  '.git',
  'dist',
  'node_modules',
];

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(abs).sort()) walk(path.join(rel, e), out);
  } else if (st.isFile()) {
    out.push(rel);
  }
}

function collect() {
  const files = [];
  for (const rel of INCLUDE) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { console.warn('  ⚠ 跳过（不存在）：' + rel); continue; }
    walk(rel, files);
  }
  // 二次过滤
  return files.filter((f) => {
    const top = f.split(path.sep)[0];
    const never = NEVER.some((n) => f === n || f.startsWith(n + path.sep) || top === n);
    if (never) { console.warn('  ⚠ 已排除：' + f); return false; }
    return true;
  });
}

/**
 * 把权限**归一化**：只保留「可执行位」这一个信息。
 *
 * ## 为什么（踩过的坑）
 *
 * 直接用源文件的 `st_mode` 会导致**同样的源码在不同机器上打出不同的 zip**：
 * 我在 proot 里 umask 让文件是 `0600`，而 GitHub runner 上是 `0644` ——
 * 32 个条目的内容（size/CRC）完全一样，只有权限位不同，zip 的 sha256 就不一样。
 *
 * 归一化后：
 *  - 同一份源码在**任何环境**打出的 zip **逐字节相同**（sha256 可对账）；
 *  - 发布包解压出来也不会是「只有 owner 能读」的怪文件。
 */
function normMode(mode) {
  return (mode & 0o111) ? 0o755 : 0o644;
}

function human(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

/** 用 python3 的 zipfile 打包（跨平台可用，且能带目录结构）。 */
function zip(srcDir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const py = `
import os, sys, zipfile
src, dst, top = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for f in sorted(files):
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src)
            arc = os.path.join(top, rel).replace(os.sep, '/')
            # 保留可执行位（start.sh / *.js）
            st = os.stat(full)
            zi = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = (st.st_mode & 0o777) << 16
            with open(full, 'rb') as fh:
                z.writestr(zi, fh.read())
print('zipped', dst)
`;
  const r = spawnSync('python3', ['-c', py, srcDir, zipPath, NAME], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('zip 失败：' + (r.stderr || r.stdout));
}

// ---------------------------------------------------------------- 主流程

console.log('== 打发布包 ==');
console.log('版本 :' + VERSION);
console.log('目标 :' + path.relative(ROOT, ZIPPATH));
console.log('');

const files = collect();
console.log('\n共 ' + files.length + ' 个文件：');
let total = 0;
for (const f of files) {
  const s = fs.statSync(path.join(ROOT, f)).size;
  total += s;
  console.log('  ' + String(human(s)).padStart(9) + '  ' + f);
}
console.log('  ' + String(human(total)).padStart(9) + '  (合计)');

// 复制到 OUTDIR
fs.rmSync(OUTDIR, { recursive: true, force: true });
fs.mkdirSync(OUTDIR, { recursive: true });
for (const f of files) {
  const dst = path.join(OUTDIR, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const srcMode = fs.statSync(path.join(ROOT, f)).mode;
  fs.copyFileSync(path.join(ROOT, f), dst);
  fs.chmodSync(dst, normMode(srcMode));      // 归一化 → 跨环境可复现
}

// ---------------------------------------------------------------- 验证
console.log('\n== 验证打包结果（在隔离目录里真跑一遍）==');

// 1) 绝不能含敏感/无关内容
const allInPkg = [];
(function w(d) { for (const e of fs.readdirSync(d)) { const p = path.join(d, e); fs.statSync(p).isDirectory() ? w(p) : allInPkg.push(path.relative(OUTDIR, p)); } })(OUTDIR);
const leaks = allInPkg.filter((f) =>
  /(^|\/)(data|node_modules)(\/|$)/.test(f)
  || f.includes('.sqlite')
  || /(^|\/)cloudflared$/.test(f)          // 只挡二进制本体，不挡 get-cloudflared.sh
  || f.startsWith('bin/native'));
if (leaks.length) { console.error('  ✘ 包内出现不应有的文件：' + leaks.join(', ')); process.exit(1); }
console.log('  [OK] 无 data/ 、无 sqlite、无 cloudflared、无 bin/native');

// 2) 关键文件在位
for (const must of ['server.js', 'start.bat', 'start.sh', 'bin/keystream.bin', 'src/keystream.js']) {
  if (!fs.existsSync(path.join(OUTDIR, must))) { console.error('  ✘ 缺关键文件：' + must); process.exit(1); }
}
console.log('  [OK] server.js / start.bat / start.sh / bin/keystream.bin 均在位');

// 3) 真跑自检（不依赖 bin/native）
const st = spawnSync(process.execPath, ['bin/selftest.js'], { cwd: OUTDIR, encoding: 'utf8' });
const stOut = (st.stdout || '') + (st.stderr || '');
const passLine = /全部通过/.test(stOut);
console.log('  [' + (st.status === 0 && passLine ? 'OK' : '✘') + '] bin/selftest.js → ' +
  (stOut.trim().split('\n').pop() || '(无输出)'));
if (st.status !== 0 || !passLine) { console.error(stOut); process.exit(1); }

// 4) 真起一次服务并 curl
const PORT = 8799;
fs.rmSync(path.join(OUTDIR, 'data'), { recursive: true, force: true });
const srv = spawnSync('bash', ['-c',
  `PK_PORT=${PORT} node server.js > /tmp/rel-test.log 2>&1 & echo $!`], { cwd: OUTDIR, encoding: 'utf8' });
const pid = (srv.stdout || '').trim();
try {
  // 等端口起来
  let code = '000';
  for (let i = 0; i < 20; i++) {
    const c = spawnSync('curl', ['-s', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}',
      `http://127.0.0.1:${PORT}/`], { encoding: 'utf8' });
    code = (c.stdout || '').trim();
    if (code === '200') break;
    spawnSync('sleep', ['0.5']);
  }
  console.log('  [' + (code === '200' ? 'OK' : '✘') + '] 起服务后 GET / → HTTP ' + code);
  if (code !== '200') { console.error(execFileSync('cat', ['/tmp/rel-test.log'], { encoding: 'utf8' })); process.exit(1); }
} finally {
  if (pid) spawnSync('kill', [pid]);
  spawnSync('bash', ['-c', `pkill -f 'node server.js' >/dev/null 2>&1 || true`]);
}
fs.rmSync(path.join(OUTDIR, 'data'), { recursive: true, force: true });

// ---------------------------------------------------------------- 压缩
const DIR_ONLY = process.argv.includes('--dir');
if (DIR_ONLY) {
  console.log('\n== 完成（--dir：只留解压目录，不打 zip）==');
  console.log('  dir :' + path.relative(ROOT, OUTDIR));
} else {
  zip(OUTDIR, ZIPPATH);
  const zsize = fs.statSync(ZIPPATH).size;
  console.log('\n== 完成 ==');
  console.log('  zip :' + path.relative(ROOT, ZIPPATH) + '   ' + human(zsize));
  console.log('  sha256: ' + require('node:crypto').createHash('sha256')
    .update(fs.readFileSync(ZIPPATH)).digest('hex'));
}