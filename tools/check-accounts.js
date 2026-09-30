const db = require('/root/pk-node/src/db');
const { config } = require('/root/pk-node/src/config');
db.init(config.dbFile);
const ids = process.argv.slice(2).map(Number);
for (const id of (ids.length ? ids : [6, 7, 22])) {
  const a = db.getLeoAccount(id);
  if (!a) { console.log(id, '无此账号'); continue; }
  let ck = a.cookies_json || '';
  let n = 0, keys = [];
  try { const o = JSON.parse(ck); keys = Object.keys(o); n = keys.length; } catch (e) {}
  console.log(id, '|', a.name, '| user_id=' + a.user_id, '| grade=' + a.grade,
    '| cookie键=' + n, '| 长度=' + String(ck).length);
  if (keys.length) console.log('     keys:', keys.join(','));
  if (n) {
    try {
      const o = JSON.parse(ck);
      const has = ['sid', 'ks_sess', 'sess', '__sub_user_infos__'].filter((k) => k in o);
      console.log('     关键键存在:', has.join(',') || '(无)');
    } catch (e) {}
  }
}