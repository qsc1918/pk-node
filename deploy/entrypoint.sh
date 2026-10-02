#!/bin/sh
# 容器启动入口：先把 SQLite / secret.key 从 R2 拉回来，再起 pk-node；
# 收到 SIGTERM（Cloudflare 停实例前会发）时，立刻把最新数据推回 R2。
#
# 为什么必须这样：Cloudflare Containers 的磁盘是 **临时** 的 ——
# 实例休眠/迁移后下次启动是「全新磁盘」，SQLite 会丢。R2 才是真正的持久层。
set -eu

echo "[entrypoint] 恢复数据（R2 → 本地）"
node /app/tools/r2-sync.js restore || echo "[entrypoint] 警告：恢复失败（首次部署属正常），继续启动"

echo "[entrypoint] 启动 pk-node"
node /app/bin/start.js &
APP_PID=$!

# 收到 SIGTERM/SIGINT：备份后退出（Cloudflare 最多等 15 分钟）
shutdown() {
  echo "[entrypoint] 收到停止信号，备份数据（本地 → R2）"
  node /app/tools/r2-sync.js backup || echo "[entrypoint] 警告：备份失败"
  kill -TERM "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  echo "[entrypoint] 已退出"
  exit 0
}
trap shutdown TERM INT

# 每 5 分钟增量备份一次（防实例被强杀时丢太多）
(
  while true; do
    sleep 300
    node /app/tools/r2-sync.js backup >/dev/null 2>&1 || true
  done
) &

wait "$APP_PID"