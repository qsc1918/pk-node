#!/usr/bin/env bash
# 下载 cloudflared（Cloudflare 快速隧道客户端）到 bin/cloudflared。
#
# 只在需要「临时内网穿透」时才用得上；不装也不影响本地使用。
#
# 用法：
#   sh bin/get-cloudflared.sh            # 自动选架构
#   BIN=cloudflared-linux-amd64 sh bin/get-cloudflared.sh
#
# 说明：cloudflared 是 Cloudflare 官方发布的可执行文件，直接从 GitHub
# Releases 拉取。下载后 `cloudflared tunnel --url http://127.0.0.1:<port>`
# 会分配一个 `*.trycloudflare.com` 的临时公网地址（免账号）。

set -u

cd "$(dirname "$0")/.."
DEST="${DEST:-bin/cloudflared}"

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) DEFAULT_BIN="cloudflared-linux-arm64" ;;
  x86_64|amd64)  DEFAULT_BIN="cloudflared-linux-amd64" ;;
  armv7l|armv7)  DEFAULT_BIN="cloudflared-linux-arm" ;;
  *) echo "未知架构：$ARCH，请手动指定 BIN=..." >&2; exit 1 ;;
esac
BIN="${BIN:-$DEFAULT_BIN}"

URL="https://github.com/cloudflare/cloudflared/releases/latest/download/$BIN"

mkdir -p "$(dirname "$DEST")"
echo "下载 $URL"
echo "  -> $DEST"

if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --retry-delay 2 -o "$DEST" "$URL" || { echo "下载失败" >&2; exit 1; }
elif command -v wget >/dev/null 2>&1; then
  wget -O "$DEST" "$URL" || { echo "下载失败" >&2; exit 1; }
else
  echo "需要 curl 或 wget" >&2
  exit 1
fi

chmod +x "$DEST"
echo "完成：$("$DEST" --version 2>&1 | head -1)"
echo "现在可以在网页「穿透」页点启动，或运行："
echo "  $DEST tunnel --url http://127.0.0.1:8787"