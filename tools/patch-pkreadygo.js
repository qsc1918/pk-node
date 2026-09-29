const fs = require('fs');
const p = '/root/pk-node/src/pk-h5-proxy.js';
let s = fs.readFileSync(p, 'utf8');

/* ===== A) rewriteAssetJs：PKReadyGo 倒计时 watcher 补 immediate ===== */
const anchorEarly = "  if (s.indexOf('__pkNotLocalHost') >= 0) return Buffer.from(s, 'utf8');";
if (s.indexOf(anchorEarly) < 0) { console.error('A anchor missing'); process.exit(1); }
if (s.indexOf('__pkReadyGoImm') < 0) {
  const block = [
    "",
    "  // ★★ 2026-09-30：PKReadyGo 倒计时 watcher 缺 immediate →「答对 N 题」遮罩卡死",
    "  //",
    "  //  组件 PKReadyGo（index-legacy.Blmv9pEj.js）：",
    "  //    watch(() => props.start, e => { if (e) { ...3.5s...; emit('readyGoEnd') } })",
    "  //  **没写 immediate**。父组件在匹配动画约 4.5s 后才把 start 置 true，",
    "  //  而 PKReadyGo 是 v-if=\"数据就绪\" 才挂载。真机 match/v2 快 → 先就绪后开赛 →",
    "  //  watch 能触发；我们走代理+桥解密更慢 → 开赛(start=true)先于就绪 → 组件挂载时",
    "  //  start 已是 true → watch 永不触发 → readyGoEnd 永不 emit → 计时器/答题流程",
    "  //  不启动 → 永远卡在「答对 N 题」遮罩。",
    "  //",
    "  //  改写：在 watch 的 options 位置插入 {immediate:!0}（幂等，带标记）。",
    "  {",
    "    var RG_HEAD = '(()=>i.start,e=>{e&&setTimeout(';",
    "    var RG_TAIL = '},2e3)}),(t,n)=>';",
    "    var iH = s.indexOf(RG_HEAD);",
    "    if (iH >= 0 && s.indexOf('__pkReadyGoImm') < 0) {",
    "      var iT = s.indexOf(RG_TAIL, iH);",
    "      if (iT > iH) {",
    "        // TAIL 偏移 7 是 p(...) 的收尾 ')'，把 options 插在它之后",
    "        var at = iT + 7;",
    "        if (s.charAt(at) === ')') {",
    "          s = s.slice(0, at + 1) + ',/*__pkReadyGoImm*/{immediate:!0}' + s.slice(at + 1);",
    "          console.log('[pk-h5] 已给 PKReadyGo 倒计时 watcher 补 immediate');",
    "        }",
    "      }",
    "    }",
    "  }",
  ].join('\n');
  s = s.replace(anchorEarly, block + '\n' + anchorEarly, 1);
}
fs.writeFileSync(p, s);
console.log('ok A');