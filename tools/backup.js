'use strict';
/**
 * 可靠备份（**自带校验**）。
 *
 * 不用 `cp -r`：在 MSYS / Git Bash 下，目标不存在时 `cp -r 源 目标` 只会建空目录、
 * 退出码仍为 0（"假成功"），事后才发现是空的。本脚本用 Node 的 `fs.cpSync`，跨平台、行为确定。
 *
 * 用法：
 *   node tools/backup.js                          # 备份到 ../_backup/pk-node-<时间戳>/pk-node
 *   node tools/backup.js <源目录> <备份根目录>
 *
 * 备份完会**逐项校验**关键资产，缺一个就非零退出。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const src = path.resolve(process.argv[2] || ROOT);
const destRoot = path.resolve(process.argv[3] || path.join(ROOT, '..', '_backup'));

const ts = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
const dest = path.join(destRoot, 'pk-node-' + ts, 'pk-node');

/** 关键资产：这些少一个就说明备份没拷全（尤其是两套签名资产）。 */
const KEY_FILES = [
  'bin/native/lre.so',        // 练习版签名 so
  'bin/native/lre_pk.so',     // PK 版签名 so
  'src/lre-insns.js',         // 练习版指令表
  'src/lre-insns-pk.js',      // PK 版指令表
  'src/native.js',
  'src/lre-emu.js',
  'src/config.js',
  'src/leo.js',
  'src/exercise.js',
];

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

console.log('源    :', src);
console.log('目标  :', dest);

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.cpSync(src, dest, {
  recursive: true,
  // node_modules 可重装；.git 不拷（git 本身就是另一条恢复路径）
  filter: (p) => !/(^|[\\/])node_modules$/.test(p) && !/(^|[\\/])\.git$/.test(p),
});

const n = countFiles(dest);
console.log('文件数:', n);
if (n === 0) {
  console.error('❌ 备份为空（一个文件都没拷到）');
  process.exit(1);
}

let bad = 0;
for (const f of KEY_FILES) {
  const ok = fs.existsSync(path.join(dest, f));
  const size = ok ? fs.statSync(path.join(dest, f)).size : 0;
  console.log(`  ${ok ? '✅' : '❌'} ${f}${ok ? ' (' + size + ' bytes)' : ''}`);
  if (!ok) bad++;
}

if (bad) {
  console.error(`❌ 备份不完整：缺 ${bad} 个关键文件`);
  process.exit(1);
}
console.log('✅ 备份校验通过');
