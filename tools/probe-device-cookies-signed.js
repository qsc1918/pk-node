#!/usr/bin/env node
'use strict';
/**
 * 用 **pk-node 的完整出站链路（含 sign）** 打真机会话的那两个端点。
 *
 * ## 为什么要这一步
 *
 * 上一轮 probe-device-cookies.js **没带 sign**，拿到 417 ——
 * 那是被 solar-encoder 挡在门外，**还没进 leo-auth 层**。
 * 而真机 App 拿到的是 **401**（leo-auth 拒绝），说明 sign 那关已经过了。
 *
 * 要复现 401，就必须带上 sign —— 直接用 pk-node 现成的 leo.js 封装。
 *
 * ## 判定
 *
 *   · 这里也 401 ⇒ **凭据问题**（这条链对 leo-auth 无效，需重新注册/换链）
 *   · 这里 200    ⇒ **App 构造差异**（cookie 组装 / 头 / 参数）
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { CookieJar } = require(path.join(ROOT, 'src', 'http'));
const leo = require(path.join(ROOT, 'src', 'leo'));

const cookies = JSON.parse(fs.readFileSync('/tmp/dev_cookies.json', 'utf8'));
const jar = new CookieJar(cookies);

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(86)); line(t); line('='.repeat(86)); }

(async () => {
  hr('用 pk-node 完整链路（含 sign）测真机会话');

  // ① batchGet —— 真机 401，拿名字/头像的那条
  hr('① GET /leo-profile/android/user-infos/batchGet');
  try {
    const r = await leo.subAccountsBatchGet(jar);
    const ok = r.status === 200;
    line('  ' + (ok ? '✅' : '❌') + ' HTTP ' + r.status);
    line('  body: ' + String(r.text || '').slice(0, 500).replace(/\s+/g, ' '));
  } catch (e) {
    line('  ❌ 异常：' + ((e && e.message) || e));
  }

  await new Promise((r) => setTimeout(r, 1000));

  // ② 知识点 —— 真机 401
  hr('② GET /leo-math/android/exams/exercises/type/0');
  try {
    const [status, text] = await new Promise((resolve) => {
      // leo.js 没导出这个封装，直接用底层 request + buildUrl
      const { request } = require(path.join(ROOT, 'src', 'http'));
      const url = leo.buildUrl
        ? leo.buildUrl('/leo-math/android/exams/exercises/type/0',
          { grade: 13, semester: 1, book: 1 })
        : null;
      if (!url) {
        resolve([0, '（leo.buildUrl 未导出，跳过）']);
        return;
      }
      request({
        url, method: 'GET', jar, headers: leo.mainDomainHeaders(),
      }).then((r2) => resolve([r2.status, r2.text])).catch((e) => resolve([-1, String(e.message)]));
    });
    line('  ' + (status === 200 ? '✅' : '❌') + ' HTTP ' + status);
    line('  body: ' + String(text || '').slice(0, 400).replace(/\s+/g, ' '));
  } catch (e) {
    line('  ❌ 异常：' + ((e && e.message) || e));
  }

  hr('导出接口探测');
  line('  leo.buildUrl: ' + (typeof leo.buildUrl));
  line('  leo.mainDomainHeaders: ' + (typeof leo.mainDomainHeaders));
  line('  leo 导出键: ' + Object.keys(leo).join(', '));

  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });