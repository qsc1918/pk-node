const db = require('/root/pk-node/src/db');
const { config } = require('/root/pk-node/src/config');
db.init(config.dbFile);
const jobs = require('/root/pk-node/src/jobs');
const leo = require('/root/pk-node/src/leo');

const pkId = process.argv[2] || '870040401132920837';
const leoId = Number(process.argv[3] || 6);
const acc = db.getLeoAccount(leoId);
if (!acc) { console.log('no acc'); process.exit(0); }

(async () => {
  const jar = jobs.jarOf(acc);
  const r = await leo.pkHistoryDetail(jar, pkId);
  console.log('status', r.status);
  let j = r.json;
  if (!j && r.text) { try { j = JSON.parse(r.text); } catch (e) {} }
  if (!j) { console.log('body:', String(r.text).slice(0, 400)); return; }
  console.log('顶层键:', Object.keys(j).join(','));
  const keys = ['correctCnt', 'questionCnt', 'costTime', 'pointName', 'pkResult',
    'selfWinCount', 'otherWinCount', 'questions', 'examVO', 'reward', 'rankCapacity', 'capacity'];
  for (const k of keys) {
    const v = j[k];
    if (Array.isArray(v)) console.log(' ', k, '= array len', v.length);
    else if (v && typeof v === 'object') console.log(' ', k, '= obj keys:', Object.keys(v).join(','));
    else console.log(' ', k, '=', JSON.stringify(v));
  }
  if (j.examVO) {
    console.log('  --- examVO 子字段 ---');
    for (const k of ['questionCnt', 'costTime', 'targetCostTime', 'pkIdStr', 'pointId', 'pointName', 'questions']) {
      const v = j.examVO[k];
      console.log('   examVO.' + k, '=', Array.isArray(v) ? 'array len ' + v.length : JSON.stringify(v));
    }
  }
  if (Array.isArray(j.questions) && j.questions[0]) {
    console.log('  questions[0] keys:', Object.keys(j.questions[0]).join(','));
  }
})().catch((e) => console.log('ERR', e.message));