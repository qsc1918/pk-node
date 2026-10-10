#!/usr/bin/env node
'use strict';
/**
 * 决定性验证：出题冷却是「每账号独立」还是「全局共享」？
 *
 * ## 为什么这是关键
 *   已知（tools/recheck-cooldown.js）：
 *     · 单账号零间隔连发 → 第 1 次 200，之后全 429
 *     · 1.2s 间隔也一样全 429
 *     ⇒ 单账号已不可能做到 1.3s/轮。
 *
 *   但如果冷却是**每账号独立**的（历史文案写的是「约 1 秒/**账号**」），
 *   那么：
 *     · N 个账号各自持有自己的窗口
 *     · 并行跑 N 个账号 ⇒ 整体吞吐 ≈ N × 单账号
 *     · 「冲榜模式」= 极简干等 + 多账号并行
 *
 *   若冷却是**全局**的（按 IP / 设备 / 产品），多账号也没用。
 *
 * ## 本实验（多账号同刻并发出题，看各自的状态码）
 *   取若干账号，同一个瞬间各发一次出题：
 *     · 全部 200 ⇒ 每账号独立（可并行放大）
 *     · 只 1 个 200、其余 429 ⇒ 全局共享（并行无益）
 */
const path = require('node:path');
const ROOT = '/root/pk-node';

const db = require(path.join(ROOT, 'src', 'db'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const exercise = require(path.join(ROOT, 'src', 'exercise'));

const KP = Number(process.argv[2] || 235001);
const NQ = Number(process.argv[3] || 10);
const IDS = (process.argv[4] || '').split(',').filter(Boolean).map(Number);

function line(s) { console.log(s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr(t) { line(''); line('='.repeat(86)); line(t); line('='.repeat(86)); }

(async () => {
  db.init();

  // 没指定就用「有 cookie 的账号」前若干个
  let ids = IDS;
  if (!ids.length) {
    const rows = db.listLeoAccounts();
    ids = (rows || []).map((a) => a.id).slice(0, 6);
    line('未指定账号，取前 6 个：' + ids.join(','));
  }

  hr('并发出题（同一瞬间）');
  const tasks = ids.map(async (id) => {
    const acc = db.getLeoAccount(id);
    if (!acc) return { id: id, status: null, msg: '账号不存在' };
    const t = Date.now();
    try {
      const g = await exercise.getExam(jobs.jarOf(acc), KP, NQ, {});
      return { id: id, name: acc.name, status: g.status, ms: Date.now() - t,
        msg: String(g.text || '').slice(0, 70).replace(/\s+/g, ' ') };
    } catch (e) {
      return { id: id, name: acc.name, status: null, ms: Date.now() - t, msg: e.message };
    }
  });

  const res = await Promise.all(tasks);
  for (const r of res) {
    const tag = r.status === 200 ? '✅ 200' : ('❌ ' + r.status);
    line('  id=' + String(r.id).padEnd(4) + (r.name || '').slice(0, 10).padEnd(12)
      + tag.padEnd(9) + (r.ms + 'ms').padEnd(8) + r.msg);
  }

  hr('判定');
  const ok = res.filter((r) => r.status === 200).length;
  const limited = res.filter((r) => r.status === 429).length;
  line('  成功 ' + ok + ' / 限流 ' + limited + ' / 共 ' + res.length);
  if (ok >= 2) {
    line('  ✅ 多个账号同刻都放行 ⇒ **每账号独立冷却**');
    line('     ⇒ 冲榜模式应「把干等压到最小 + 多账号并行」，吞吐 ≈ N × 单账号');
  } else if (limited >= res.length - 1 && res.length > 1) {
    line('  ⚠️ 只有 ' + ok + ' 个放行 ⇒ 疑似**全局共享**冷却（按 IP/设备）');
    line('     ⇒ 多账号并行也放不大，只能老实按冷却跑');
  } else {
    line('  样本不足，重跑一次或换账号组');
  }
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });