'use strict';
// 挑一个空闲端口（用于 start.sh 自动避让被占端口）。
//
// 为什么需要它：本机（proot）里 `ss`/`netstat` 看不到宿主侧的监听，
// 所以「端口是否被占」只能靠真正 listen 一次来判断 —— 用 Node 自己试最准。
//
// 用法：
//   node bin/pick-port.js            # 从 8787 开始试，输出可用端口
//   node bin/pick-port.js 9000 9020  # 在 [9000, 9020) 区间里找

const net = require('node:net');

const start = Number(process.argv[2] || 8787);
const end = Number(process.argv[3] || start + 20);

/** 尝试监听某端口；成功则立刻关闭并返回 true。 */
function tryPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    // 与 server.js 保持一致：只绑回环
    srv.listen(port, '127.0.0.1');
  });
}

(async () => {
  for (let p = start; p < end; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await tryPort(p)) {
      process.stdout.write(String(p));
      process.exit(0);
    }
  }
  process.stderr.write(`在 ${start}..${end - 1} 内没找到空闲端口\n`);
  process.exit(1);
})();