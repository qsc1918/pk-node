#!/usr/bin/env bash
# 把 pk-node 部署到 alwaysdata（免费版即可）。
#
# 用法：
#   bash deploy/alwaysdata/deploy.sh <account> [ssh-host]
#
# 例：
#   bash deploy/alwaysdata/deploy.sh sxd91
#
# 若要用密码非交互登录，先设环境变量（需要一个 sshpass）：
#   ALWAYSDATA_PASSWORD='你的密码' bash deploy/alwaysdata/deploy.sh sxd91
# 否则脚本会用 ssh 默认方式（密钥，或在你终端里手动输密码）。
#
# 它做四件事：
#   1) 打包含（调 make-package.sh）
#   2) 上传到服务器 home
#   3) 远程解压到 ~/www/pk-node（**保留已有的 data/**，SQLite 不能丢）
#   4) 远程跑 selftest 自检
#
# 建「Node.js 站点」这一步要在控制面板点几下（见同目录 SETUP.md），
# 因为站点要绑定地址 + 端口，属于账号级配置。
set -euo pipefail

ACCOUNT="${1:-}"
if [ -z "$ACCOUNT" ]; then
  echo "用法：bash deploy/alwaysdata/deploy.sh <account> [ssh-host]" >&2
  exit 1
fi
HOST="${2:-ssh-$ACCOUNT.alwaysdata.net}"
TARBALL="pk-node-alwaysdata.tar.gz"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "== 1/4 打包含 =="
bash deploy/alwaysdata/make-package.sh

# 有密码就走 sshpass（非交互）；没有就用 ssh 默认（密钥 / 交互输密码）
SSH_CMD=(ssh)
SCP_CMD=(scp)
if [ -n "${ALWAYSDATA_PASSWORD:-}" ]; then
  if command -v sshpass > /dev/null 2>&1; then
    SSH_CMD=(sshpass -p "$ALWAYSDATA_PASSWORD" ssh -o StrictHostKeyChecking=accept-new)
    SCP_CMD=(sshpass -p "$ALWAYSDATA_PASSWORD" scp -o StrictHostKeyChecking=accept-new)
  else
    echo "[!] 设了 ALWAYSDATA_PASSWORD 但没装 sshpass。" >&2
    echo "    装一个：sudo apt-get install -y sshpass" >&2
    echo "    或者不设该变量，用 SSH 密钥登录。" >&2
    exit 1
  fi
fi

echo
echo "== 2/4 上传到 $ACCOUNT@$HOST =="
"${SCP_CMD[@]}" "dist/$TARBALL" "$ACCOUNT@$HOST:~/"

echo
echo "== 3/4 远程解压（保留旧 data/）=="
REMOTE_UNPACK='
set -e
TARBALL=~/pk-node-alwaysdata.tar.gz
DIR=~/www/pk-node
if [ -d "$DIR/data" ]; then
  mv "$DIR/data" ~/pk-node-data-backup
  echo "已备份旧 data/"
fi
mkdir -p "$DIR"
tar -xzf "$TARBALL" -C "$DIR"
if [ -d ~/pk-node-data-backup ]; then
  rm -rf "$DIR/data"
  mv ~/pk-node-data-backup "$DIR/data"
  echo "已还原旧 data/"
fi
chmod +x "$DIR/start.sh" || true
echo "文件已就位：$DIR"
ls -la "$DIR" | head -20
'
"${SSH_CMD[@]}" "$ACCOUNT@$HOST" "$REMOTE_UNPACK"

echo
echo "== 4/4 远程自检 =="
"${SSH_CMD[@]}" "$ACCOUNT@$HOST" \
  "cd ~/www/pk-node; /usr/bin/env node bin/selftest.js 2>&1 | tail -30"

echo
echo "==================== 下一步（在控制面板点几下）===================="
echo "1. Web > Sites > Add a site"
echo "     Name        : pk-node"
echo "     Addresses   : $ACCOUNT.alwaysdata.net"
echo "     Type        : Node.js"
echo "     Command     : node /home/$ACCOUNT/www/pk-node/bin/start.js"
echo "     Working dir : /home/$ACCOUNT/www/pk-node"
echo "2. 该站点的 Advanced > Idle time 拉到最大（否则空闲会被停，变成「休眠」）"
echo "3. 打开 https://$ACCOUNT.alwaysdata.net ，用 admin / admin 登录并**立刻改密码**"
echo "=================================================================="