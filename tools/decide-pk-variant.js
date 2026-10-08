#!/usr/bin/env node
'use strict';
/**
 * 决定性实验：PK 端点的 sign 该用哪套资产？
 *
 * ## 背景
 *   真机 App 里的 PK 请求，签名由**原生 LeoSecure 桥**完成
 *   （bundle 里：有原生桥时 `s("requestConfig", {path, trigger})`；
 *     无桥才降级成 `{client}`→`api` 的明文请求）。
 *
 *   而设备上**只有一份** `libRequestEncoder.so`（3.141.1，919568 B）。
 *   项目却有两套资产：
 *     · exercise → lre.so（已同步 3.141.1）
 *     · pk       → lre_pk.so（919648 B，旧构建）
 *
 * ## 设计
 *   对**同一个 PK 端点**，分别用两套 variant 算 sign，实际请求，
 *   看哪个能拿到 200（而不是 417）。
 *
 *   判据很利：
 *     · 200  → 这套资产是对的
 *     · 417  → sign 校验失败（x-block-by: solar-encoder）
 *     · 401/403 → 登录态/风控问题，与 sign 无关
 *
 * ## 端点选择
 *   用 `GET /leo-game-pk/android/math/pk/home?grade=2`：
 *     · GET，无副作用
 *     · 属于 /leo-game-pk → 走 pk 变体
 */
const path = require('node:path');
const root = '/root/pk-node';

const db = require(path.join(root, 'src', 'db'));
const jobs = require(path.join(root, 'src', 'jobs'));
const leo = require(path.join(root, 'src', 'leo'));
const nativeLib = require(path.join(root, 'src', 'native.js'));
const { request } = require(path.join(root, 'src', 'http'));

const ACC_ID = Number(process.argv[2] || 15);
const PATH_PK = '/leo-game-pk/android/math/pk/home';
const QUERY = { grade: '2' };

function line(s) { console.log(s); }

(async () => {
  db.init();
  const acc = db.getLeoAccount(ACC_ID);
  if (!acc) {
    line('找不到账号 id=' + ACC_ID);
    process.exit(1);
  }
  line('='.repeat(80));
  line('账号 id=' + acc.id + '  name=' + (acc.name || '-') + '  yfd_u=' + acc.yfd_u);
  line('='.repeat(80));

  const jar = jobs.jarOf(acc);

  for (const variant of ['exercise', 'pk']) {
    line('');
    line('-'.repeat(80));
    line('variant = ' + variant);
    line('-'.repeat(80));

    // 用指定 variant 手工组 URL（绕过 buildUrl 内部的自动选择）
    let url;
    let sign;
    try {
      const q = Object.assign({}, QUERY);
      // 公共参数（真机逐字）
      q._productId = '611';
      q.platform = 'android37';
      q.version = '3.141.1';
      q.vendor = 'UC';
      q.deviceCategory = 'phone';
      q.av = '5';
      q.webviewVersion = '150';
      q.whRatio = '2.17';
      q.isBackground = '1';

      sign = nativeLib.calcSign(PATH_PK, { variant: variant });
      const qs = Object.keys(q).map((k) => k + '=' + encodeURIComponent(q[k])).join('&');
      url = 'https://xyks.yuanfudao.com' + PATH_PK + '?' + qs + '&sign=' + sign;
    } catch (e) {
      line('  组 URL 失败: ' + e.message);
      continue;
    }

    line('  sign = ' + sign);

    try {
      const r = await request({
        url: url,
        method: 'GET',
        jar: jar,
        headers: leo.riskHeaders(),
        timeoutMs: 20000,
      });
      const blk = (r.headers && (r.headers['x-block-by'] || r.headers['X-Block-By'])) || '-';
      line('  → HTTP ' + r.status + '   x-block-by=' + blk);
      line('    body: ' + String(r.text || '').slice(0, 260).replace(/\s+/g, ' '));
    } catch (e) {
      line('  → 请求异常: ' + e.message);
    }
  }

  line('');
  line('='.repeat(80));
  line('判定');
  line('='.repeat(80));
  line('  哪个 variant 返回 200 → 那就是 PK 该用的资产。');
  line('  两个都 417 → 说明两套都不对（或该端点本就需要别的凭据）。');
  process.exit(0);
})().catch((e) => {
  console.error('失败:', (e && e.stack) || e);
  process.exit(1);
});