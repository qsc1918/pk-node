#!/usr/bin/env node
'use strict';
/**
 * 决定性验证：**出题 → 作答 → 提交** 全链，确认 `/v2/` + 编码 = 200。
 *
 * ## 为什么必须全链
 *
 * 上一轮用「真机 id + 空 questions」提交 → 400（body 内容不对，
 * 那是预期的：服务端要真的回放笔迹判卷）。
 *
 * 本轮用 pk-node 的 `exercise.runPractice`（它内部就是
 * 出题 → answerAll（含笔迹）→ submitExam），看它能不能 200。
 *
 * 这是「内置 pk-node 提交没问题」的**正向对照**——
 * 若 pk-node 能过而 App 不能，说明差异就在 App 的请求构造。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(90)); line(t); line('='.repeat(90)); }

const IDS = (process.argv[2] || '5,32,35,36,15,18').split(',').map(Number);
const KP = Number(process.argv[3] || 235001);
const NQ = Number(process.argv[4] || 10);

(async () => {
  db.init();

  hr('pk-node 练习全链（出题 → 作答 → 提交）');

  for (const id of IDS) {
    const a = db.getLeoAccount(id);
    if (!a) { line('  id=' + id + ' 不存在，跳过'); continue; }
    const jar = jobs.jarOf(a);

    try {
      const r = await exercise.runPractice(jar, {
        keypointId: KP,
        limit: NQ,
        costTimeMs: 200,
        onEvent: (ev) => {
          const msg = (ev && ev.message) || JSON.stringify(ev);
          if (/出题|提交|判|等待|成功|失败/.test(msg)) {
            line('    [id=' + id + '] ' + String(msg).slice(0, 110));
          }
        },
      });
      line('  ' + ('id=' + id).padEnd(10) +
        (r && r.ok ? '✅ 成功  判对 ' + r.correctCnt + '/' + r.questionCnt +
          '  经验 +' + r.exp : '❌ 失败  ' + ((r && r.error) || '?')));
    } catch (e) {
      line('  ' + ('id=' + id).padEnd(10) + '异常 ' + ((e && e.message) || e));
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  hr('说明');
  line('  · pk-node 若成功 ⇒ 它的请求构造（/v2/ + 编码 + octet-stream）是对的');
  line('  · App 的差异：路径少 /v2/、body 未编码 ⇒ 401');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });