'use strict';
// 验证 Node 内置 WebSocket（undici 实现）能否带自定义 header（upgrade 请求需 Cookie / X-Battle-Ticket）
// 用本地起一个 HTTP 服务，监听 upgrade 事件打印收到的头。

const http = require('node:http');

const server = http.createServer((req, res) => { res.end('ok'); });
server.on('upgrade', (req, socket) => {
  console.log('=== UPGRADE RECEIVED ===');
  console.log('url:', req.url);
  console.log('cookie:', req.headers['cookie']);
  console.log('x-battle-ticket:', req.headers['x-battle-ticket']);
  console.log('user-agent:', req.headers['user-agent']);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: dummy\r\n\r\n'
  );
  setTimeout(() => socket.destroy(), 200);
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const url = 'ws://127.0.0.1:' + port + '/test';
  console.log('server on', url);

  // 试验 1: 构造 options 带 headers（undici WebSocket 的第二个参数是 protocols，navigator 语义）
  try {
    const ws = new WebSocket(url, undefined);
    // undici 的 WebSocket 不接受 headers —— 试试看能不能设置
    console.log('ws created, readyState=', ws.readyState);
    ws.onopen = () => {
      console.log('OPEN');
      ws.close();
    };
    ws.onerror = (e) => {
      console.log('ERROR:', e && e.message);
    };
  } catch (e) {
    console.log('throw:', e.message);
  }

  setTimeout(() => {
    // 试验 2: WebSocket 的第三参数 option? 检查 undici 是否支持 dispatcher/headers
    console.log('--- try with options object ---');
    try {
      const ws2 = new WebSocket(url, { headers: { Cookie: 'a=1', 'X-Battle-Ticket': 'T' } });
      ws2.onopen = () => { console.log('OPEN2'); ws2.close(); };
      ws2.onerror = (e) => { console.log('ERROR2:', e && e.message); };
    } catch (e) {
      console.log('throw2:', e.message);
    }
    setTimeout(() => { server.close(); process.exit(0); }, 800);
  }, 600);
});
