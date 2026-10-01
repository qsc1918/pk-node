#!/usr/bin/env bash
# pk-node 启动脚本（Linux / macOS / WSL / Git-Bash）
#
# 用法：
#   ./start.sh                  # 默认 8792；被占则自动往后找一个空闲端口
#   PK_PORT=9000 ./start.sh     # 指定端口（被占也会自动往后找，并给出提示）
#   PK_HOST=0.0.0.0 ./start.sh  # 局域网可访问
#
# ★ 2026-10-01：本脚本现在只做「找到 node 并交给 bin/start.js」。
#   版本校验 / 端口挑选 / 横幅打印全在 bin/start.js —— Windows 的 start.bat
#   走同一个入口，两个平台共用一份逻辑，不会再出现「一边能跑一边不能跑」。
#
# 零依赖：不需要 npm install（只用 Node 内置模块）。
# 要求：Node >= 22（用到内置 node:sqlite）。

set -eu

cd "$(dirname "$0")"

NODE_BIN="${NODE_BIN:-node}"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "未找到 node，请先安装 Node.js 22+（推荐 24）" >&2
  exit 1
fi

exec "$NODE_BIN" bin/start.js
