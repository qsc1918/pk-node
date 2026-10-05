// mts.js —— MT MCP 便捷调用：node tools/mts.js <tool> <jsonArgsFile>
const http = require('node:http');
const fs = require('node:fs');
const PORT = process.env.MCP_PORT || 8791;
const PATH = process.env.MCP_PATH || '/mcp';
function rpc(body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, path: PATH, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data) } },
      (x) => { let o=''; x.on('data', d=>o+=d); x.on('end', ()=>{ const m=o.match(/data:\s*(\{[\s\S]*\})/); const t=m?m[1]:o; try{res(JSON.parse(t));}catch(e){res({raw:o});} }); });
    r.on('error', rej); r.write(data); r.end();
  });
}
(async () => {
  await rpc({ jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'pk',version:'1'} } });
  const name = process.argv[2];
  const args = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const r = await rpc({ jsonrpc:'2.0', id:2, method:'tools/call', params:{ name, arguments: args } });
  const sc = r.result && (r.result.structuredContent || r.result.content);
  console.log(JSON.stringify(sc || r));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
