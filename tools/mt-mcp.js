const http = require('node:http');
const PORT = process.env.MCP_PORT || 8791;
const PATH = process.env.MCP_PATH || '/mcp';
function rpc(body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: PATH, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (x) => {
      let o = '';
      x.on('data', (d) => { o += d; });
      x.on('end', () => {
        const m = o.match(/data:\s*(\{[\s\S]*\})/);
        const t = m ? m[1] : o;
        try { res(JSON.parse(t)); } catch (e) { res({ raw: o }); }
      });
    });
    r.on('error', rej);
    r.write(data);
    r.end();
  });
}
(async () => {
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pk', version: '1' } } });
  const mode = process.argv[2];
  if (mode === 'tools') {
    const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    for (const t of (r.result && r.result.tools) || []) console.log(t.name);
    return;
  }
  const name = process.argv[2];
  let args = {};
  try { args = JSON.parse(process.argv[3] || '{}'); } catch (e) { console.error('bad args json'); process.exit(1); }
  const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  const sc = r.result && (r.result.structuredContent || r.result.content);
  console.log(JSON.stringify(sc || r, null, 1).slice(0, 6000));
})().catch((e) => console.error('ERR', e.message));
