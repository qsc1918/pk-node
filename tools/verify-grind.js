'use strict';
/**
 * 端到端验证：现在到底能不能「刷练习 / 刷 PK」。
 *
 * 直接拿库里真实账号的 cookie 打服务端真实接口（不走网页登录流程），
 * 分别验证两条链路的核心动作：
 *   - 练习：POST /leo-math/android/exams（出题）
 *   - PK  ：POST /leo-game-pk/android/math/pk/match/v2（出题）
 *
 * 用法：node tools/verify-grind.js [leoAccountId]
 */

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { config } = require(path.join(ROOT, 'src', 'config'));
const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));
const leo = require(path.join(ROOT, 'src', 'leo'));

db.init(config.dbFile);

function pickAccount() {
  const argId = Number(process.argv[2]);
  if (argId) {
    const a = db.getLeoAccount(argId);
    if (a) return a;
  }
  const rows = db.get().prepare('SELECT * FROM leo_accounts ORDER BY id DESC').all();
  if (!rows.length) throw new Error('库里没有账号');
  return db.getLeoAccount(rows[0].id);
}

(async () => {
  const acc = pickAccount();
  console.log('账号:', acc.id, acc.name || '(无名)');
  const jar = jobs.jarOf(acc);
  console.log('cookie:', jar.items.map((c) => c.name).join(',') || '(无)');

  console.log('\n===== ① 练习：出题 POST /leo-math/android/exams =====');
  try {
    const g = await exercise.getExam(jar, 235001, 10);
    const ok = g.status === 200 && g.json && g.json.idString;
    console.log('HTTP', g.status, ok ? '✅ 出题成功' : '❌ 出题失败');
    console.log('  idString =', g.json && g.json.idString, '| 题数 =', g.json && g.json.questionCnt);
    if (!ok) console.log('  body:', String(g.text).slice(0, 120));
  } catch (e) {
    console.log('  练习出题异常:', e.message);
  }

  console.log('\n===== ② PK：出题 match/v2 =====');
  try {
    const m = await leo.pkMatchV2(jar, 64, {});
    const ok = m.status === 200;
    console.log('HTTP', m.status, ok ? '✅ 出题成功' : '❌ 出题失败');
    if (m.json) console.log('  json keys =', Object.keys(m.json).slice(0, 8).join(','));
    if (!ok) console.log('  body:', String(m.text).slice(0, 160));
  } catch (e) {
    console.log('  PK 出题异常:', e.message);
  }

  console.log('\n===== ③ 完整一轮练习（出题 → 作答 → 提交 → 批改）=====');
  try {
    const r = await exercise.runPractice(jar, { keypointId: 235001, limit: 10 });
    console.log(r.ok ? '✅ 一轮完成' : '❌ 一轮失败');
    console.log('  判对', r.correctCnt, '/', r.questionCnt, '| 经验 +', r.exp, '| examId', r.examId);
    if (!r.ok) console.log('  stage =', r.stage, '| status =', r.status, '| body:', String(r.text).slice(0, 150));
  } catch (e) {
    console.log('  一轮练习异常:', e.message);
  }

  console.log('\n===== ④ 对照：练习 homepage（主域读接口）=====');
  try {
    const hp = await exercise.homepage(jar);
    console.log('HTTP', hp.status, hp.status === 200 ? '✅' : '❌', '| body:', String(hp.text).slice(0, 90));
  } catch (e) {
    console.log('  homepage 异常:', e.message);
  }
})();
