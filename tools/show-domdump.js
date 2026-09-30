const fs = require('fs');
const file = process.argv[2] || '/tmp/pknode57.log';
const lines = fs.readFileSync(file, 'utf8').split('\n');
for (const line of lines) {
  const i = line.indexOf('{"kind":"bot-dom"');
  if (i < 0) continue;
  let o;
  try { o = JSON.parse(line.slice(i)); } catch (e) { continue; }
  const d = o.data || {};
  console.log('--- tag=' + d.tag);
  console.log('mode =', d.mode);
  console.log('ls   =', d.ls);
  console.log();
}