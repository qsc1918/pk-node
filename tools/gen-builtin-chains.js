'use strict';
/**
 * 从 ks_persistent*.txt 生成 src/builtin-chains.js（内置设备链种子）。
 *
 * 用法：
 *   node tools/gen-builtin-chains.js "G:/abc/Documents/ks_persistent.txt" "G:/abc/Documents/ks_persistent2.txt"
 *
 * 输入每行形如：
 *   ks_persistent=XXX; ks_deviceid=355436623; ks_sess=YYY; ks_persistent=XXX
 * 说明：
 *   - 原始文本里 ks_persistent 会出现两次（值相同），按 name 去重保留首个；
 *   - 只保留 ks_* 且必须含 ks_deviceid（与 extractChainFromItems 的判定一致）；
 *   - 按 ks_deviceid 去重，两份文件里若有同一台设备只留一条。
 */
const fs = require('node:fs');
const path = require('node:path');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法：node tools/gen-builtin-chains.js <txt1> [txt2] ...');
  process.exit(1);
}

const chains = [];
const seenDevice = new Set();
const dupAcross = [];

for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 按 ';' 切成 name=value；value 里可能含 '='，所以只按第一个 '=' 切
    const items = [];
    const seenName = new Set();
    for (const part of line.split(';')) {
      const seg = part.trim();
      const i = seg.indexOf('=');
      if (i <= 0) continue;
      const name = seg.slice(0, i).trim();
      const value = seg.slice(i + 1).trim();
      if (!value) continue;
      if (seenName.has(name)) continue;          // 同名重复（ks_persistent）→ 跳过
      seenName.add(name);
      items.push({ name, value });
    }

    const ks = items.filter((c) => c.name.indexOf('ks_') === 0);
    if (!ks.some((c) => c.name === 'ks_deviceid')) continue;   // 缺 ks_deviceid → 不是可用设备链

    const deviceId = ks.find((c) => c.name === 'ks_deviceid').value;
    if (seenDevice.has(deviceId)) {
      dupAcross.push({ file: path.basename(f), deviceId });
      continue;
    }
    seenDevice.add(deviceId);

    chains.push({
      label: '内置设备链 ' + String(chains.length + 1).padStart(2, '0'),
      deviceId,
      cookies: ks.map((c) => ({ name: c.name, value: c.value, domain: '.yuanfudao.com', path: '/' })),
    });
  }
}

const out = [
  "'use strict';",
  '/**',
  ' * 内置设备链池（系统内置组织）——**自动生成，请勿手改**。',
  ' *',
  ' * 生成方式：node tools/gen-builtin-chains.js <ks_persistent*.txt ...>',
  ` * 本次共 ${chains.length} 条，来源：${files.map((f) => path.basename(f)).join(' + ')}`,
  ' *',
  ' * 为什么要有内置池：设备链池默认是空的，新登录的小猿账号拿不到 ks_*，',
  ' *   PK 出题会恒定 400。不会用设备链的用户因此完全跑不起来。',
  ' *   这批内置链让「没有设备链也能用」成为默认体验。',
  ' *',
  ' * ⚠️ 安全：这里存的是 ks_* 设备指纹（device 级，非账号级），仍属敏感数据。',
  ' *   已落库时统一走 cookiecrypt 加密（AES-256-GCM），不落明文。',
  ' */',
  '',
  'const ORG = ' + JSON.stringify('系统内置') + ';',
  '',
  'const CHAINS = [',
  ...chains.map((c) => {
    const L = [];
    L.push('  {');
    L.push('    label: ' + JSON.stringify(c.label) + ',');
    L.push('    deviceId: ' + JSON.stringify(c.deviceId) + ',');
    L.push('    cookies: [');
    for (const k of c.cookies) {
      L.push('      { name: ' + JSON.stringify(k.name) + ', value: ' + JSON.stringify(k.value) +
        ", domain: '.yuanfudao.com', path: '/'},");
    }
    L.push('    ],');
    L.push('  },');
    return L.join('\n');
  }),
  '];',
  '',
  'module.exports = { ORG, CHAINS };',
  '',
].join('\n');

const dest = path.join(__dirname, '..', 'src', 'builtin-chains.js');
fs.writeFileSync(dest, out, 'utf8');

console.log('已生成 ' + dest);
console.log('共 ' + chains.length + ' 条内置设备链');
console.log('跨文件重复设备：' + (dupAcross.length ? JSON.stringify(dupAcross) : '无'));
