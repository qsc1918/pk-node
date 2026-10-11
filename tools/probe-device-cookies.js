#!/usr/bin/env node
'use strict';
/**
 * 决定性实验：用**真机当前会话**的同一套 cookie，从服务端侧打那两个 401 端点。
 *
 * ## 要裁决的问题
 *
 * 真机日志（2026-10-11 08:13~08:16）：
 *
 *     GET /profile/android/user-info                 → 200  账号域
 *     GET /leo-profile/api/user-infos/context        → 200  @CheckNothing
 *     GET /leo-profile/android/user-infos/batchGet   → 401  leo-auth
 *     GET /leo-math/.../exercises/type/0             → 401  leo-auth
 *
 * pk-node 用**同一条** ks_deviceid=350266477 是能跑通的。
 *
 * ## 两个假设
 *
 *   H1「链/会话失效」：服务端侧同样 401 → 是凭据问题，与 App 无关
 *   H2「App 构造差异」：服务端侧 200 → App 发出去的请求少了什么
 *
 * ## 做法
 *
 * 读 /tmp/dev_cookies.json（从真机 leo_session.xml 提取的明文 cookie），
 * 装进 pk-node 的 CookieJar，用**与 App 相同的路径与公共参数**发请求。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = '/root/pk-node';

const { request, CookieJar } = require(path.join(ROOT, 'src', 'http'));

const cookies = JSON.parse(fs.readFileSync('/tmp/dev_cookies.json', 'utf8'));
const jar = new CookieJar(cookies);

function line(s) { console.log(s); }
function hr(t) { line(''); line('='.repeat(86)); line(t); line('='.repeat(86)); }

const HOST = 'xyks.yuanfudao.com';

/** 组装与 App CommonQueryInterceptor 一致的公共参数（顺序也对齐）。 */
function buildUrl(pathname, extra = {}) {
  const q = new URLSearchParams();
  q.set('_productId', extra._productId || '611');
  q.set('platform', 'android' + 37);
  q.set('version', '3.140.1');
  q.set('vendor', 'UC');
  q.set('deviceCategory', 'phone');
  q.set('av', '5');
  q.set('webviewVersion', '150');
  q.set('whRatio', '2.17');
  q.set('isBackground', '0');
  for (const [k, v] of Object.entries(extra)) {
    if (k.startsWith('_')) continue;
    q.set(k, v);
  }
  return 'https://' + HOST + pathname + '?' + q.toString();
}

(async () => {
  hr('真机会话 cookie 盘点');
  for (const c of cookies) {
    if (c.name.startsWith('ks_') || ['sid', 'userid'].includes(c.name)) {
      const v = c.value;
      line('  ' + c.name.padEnd(14) + ' = ' +
        (v.length <= 36 ? v : v.slice(0, 36) + '...len=' + v.length));
    }
  }

  const targets = [
    ['/leo-profile/api/user-infos/context', { _productId: '241' }, '应 200（不校验链）'],
    ['/leo-profile/android/user-infos/batchGet', {}, '真机 401'],
    ['/leo-math/android/exams/exercises/type/0', { grade: '13', semester: '1', book: '1' }, '真机 401'],
  ];

  for (const [p, extra, note] of targets) {
    const url = buildUrl(p, extra);
    hr(p + '   ← ' + note);
    try {
      const r = await request({ url, method: 'GET', jar });
      const flag = r.status === 200 ? '✅' : '❌';
      line('  ' + flag + ' HTTP ' + r.status + '   ' + url.slice(0, 120));
      line('  body: ' + String(r.text || '').slice(0, 300).replace(/\s+/g, ' '));
    } catch (e) {
      line('  ❌ 异常：' + ((e && e.message) || e));
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  hr('判定口径');
  line('  · 服务端侧也 401  ⇒ H1：凭据/会话失效（与 App 无关，需换链或重登）');
  line('  · 服务端侧 200     ⇒ H2：App 请求构造差异（少参数/少头/ Cookie 组装错）');
  process.exit(0);
})().catch((e) => { console.error('失败:', (e && e.stack) || e); process.exit(1); });
