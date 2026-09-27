#!/usr/bin/env bash
# pk-node 启动脚本。
#
# 用法：
#   ./start.sh                  # 默认 8787；被占则自动往后找一个空闲端口
#   PK_PORT=9000 ./start.sh     # 指定端口（被占则报错退出，不偷偷换）
#   PK_HOST=0.0.0.0 ./start.sh  # 局域网可访问
#
# 零依赖：不需要 npm install（只用 Node 内置模块）。
# 要求：Node >= 22（用到 node:sqlite）。

set -u

cd "$(dirname "$0")"

NODE_BIN="${NODE_BIN:-node}"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "未找到 node，请先安装 Node.js 22+（推荐 24）" >&2
  exit 1
fi

NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node 版本过低（当前 $("$NODE_BIN" -v)），需要 >= 22（node:sqlite）" >&2
  exit 1
fi

# ---- 端口选择 ----
#
# ⚠️ 本机在 proot 里，`ss`/`netstat` **看不到宿主侧的监听**，
# 所以不能用它们判断占用 —— 必须真的 listen 一次（交给 bin/pick-port.js）。
if [ -n "${PK_PORT:-}" ]; then
  WANT="$PK_PORT"
  AVAIL="$("$NODE_BIN" bin/pick-port.js "$PK_PORT" "$((PK_PORT + 1))" 2>/dev/null || true)"
  if [ -z "$AVAIL" ]; then
    echo "端口 $PK_PORT 已被占用。换一个，或直接 ./start.sh 让它自动挑。" >&2
    exit 1
  fi
  PORT="$PK_PORT"
else
  PORT="$("$NODE_BIN" bin/pick-port.js 8787 8820 2>/dev/null || true)"
  if [ -z "$PORT" ]; then
    echo "8787~8819 都被占用了，请用 PK_PORT=<空闲端口> ./start.sh" >&2
    exit 1
  fi
  if [ "$PORT" != "8787" ]; then
    echo "提示：8787 已被占用，自动改用 $PORT"
  fi
fi

export PK_PORT="$PORT"

echo "== pk-node =="
echo "node      : $("$NODE_BIN" -v)"
echo "监听      : http://${PK_HOST:-127.0.0.1}:${PORT}"
echo "native 目录: $(pwd)/bin/native"
echo

exec "$NODE_BIN" server.js