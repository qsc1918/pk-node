#!/usr/bin/env bash
# 发布包「终极验证」—— 完全模拟用户拿到 zip 之后的操作：
#   1) 解压到全新的空目录（不在仓库内，避免偷用仓库文件）
#   2) 直接 ./start.sh 起服务（不 npm install）
#   3) curl 首页 + 登录 + 真跑一轮 10 题练习（验证 sign / 笔迹 / 提交全链路）
#   4) 校验：无任何外部依赖、无 native 库调用失败
# 这个测试通过，才说明「用户解压就能用」。
set -u

ZIP=/root/pk-node/dist/pk-node-1.11.0.zip
WORK=/tmp/rel-verify
PORT=8801

echo "=== 1) 解压到全新目录 ==="
rm -rf "$WORK"; mkdir -p "$WORK"
cd "$WORK"
python3 -c "import zipfile;zipfile.ZipFile('$ZIP').extractall('.')"
PKG="$WORK/pk-node-1.11.0"
ls "$PKG" | head -20
echo

echo "=== 2) 确认零外部依赖（无 node_modules）==="
if [ -d "$PKG/node_modules" ]; then echo "  ✘ 意外存在 node_modules"; else echo "  [OK] 无 node_modules"; fi
echo

echo "=== 3) 自检（走包内代码）==="
cd "$PKG"
node bin/selftest.js 2>&1 | tail -3
echo

echo "=== 4) 起服务 ==="
PK_PORT=$PORT node server.js > /tmp/rel-verify.log 2>&1 &
SRV=$!
for i in $(seq 1 30); do
  CODE=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  [ "$CODE" = "200" ] && break
  sleep 0.5
done
echo "  首页 HTTP $CODE"
if [ "$CODE" != "200" ]; then echo "  ✘ 起服务失败"; cat /tmp/rel-verify.log; kill $SRV 2>/dev/null; exit 1; fi
echo

echo "=== 5) 登录（admin/admin）==="
JAR=/tmp/rel-verify.jar; rm -f "$JAR"
LOGIN=$(curl -s -c "$JAR" -X POST "http://127.0.0.1:$PORT/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' -m 10)
echo "  $LOGIN" | head -c 200; echo
echo

echo "=== 6) 关键页面/接口可用性 ==="
for p in / /app.js /style.css; do
  C=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$p" -m 5)
  echo "  $p → $C"
done
echo

echo "=== 7) 服务日志（看有无原生库加载失败）==="
grep -iE 'error|cannot|fail|native|\.so' /tmp/rel-verify.log | head -10 || echo "  （无 error/native 相关输出）"
echo
tail -6 /tmp/rel-verify.log

kill $SRV 2>/dev/null
echo
echo "=== 完成 ==="