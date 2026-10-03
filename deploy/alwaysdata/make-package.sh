#!/usr/bin/env bash
# 打出「可直接上传到 alwaysdata」的部署包。
#
# ## 为什么要裁剪
#
# 完整仓库里有几样**服务器用不到**的东西：
#   - bin/native/linker64 + lib*.so + enc_device + dump*：arm64 的 Android 原生工具链，
#     只用于「跑 Android so」那条**已废弃**的备份路径（见 src/native.js：默认走纯 JS）。
#   - bin/cloudflared（37MB）：本地穿透用，服务器上由平台直接暴露端口，不需要。
#   - data/：本机数据库（含真实 cookie），**绝不能**上传。
#   - deploy/：Cloudflare Worker 那套，与 alwaysdata 无关。
#
# ## 保留的关键资产（x86_64 上也能用，已实证）
#   - bin/native/lre.so / lre_pk.so：这是**纯数据**（arm64 机器码），
#     由 src/lre-emu.js（纯 JS 模拟器）解释执行来生成 T，不需要 CPU 原生支持。
#     selftest 已验证：与真机抓包逐字节一致。
#   - bin/keystream.bin：内容编码密钥流（131072B），纯 JS XOR 用。
#
# 用法：bash deploy/alwaysdata/make-package.sh
# 产物：dist/pk-node-alwaysdata.tar.gz
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/dist"
OUT="$OUT_DIR/pk-node-alwaysdata.tar.gz"

mkdir -p "$OUT_DIR"

INCLUDE=(
  package.json
  server.js
  start.sh
  README.md
  LICENSE
  DISCLAIMER.md
  public
  src
  docs
  bin/start.js
  bin/pick-port.js
  bin/selftest.js
  bin/reset-admin.js
  bin/get-cloudflared.sh
  bin/keystream.bin
  bin/native/lre.so
  bin/native/lre_pk.so
  bin/native/NOTICE.md
)

cd "$ROOT"

# 逐个确认存在（少一个就早失败，别打出个缺东西的包）
for f in "${INCLUDE[@]}"; do
  if [ ! -e "$f" ]; then
    echo "[x] 缺少：$f" >&2
    exit 1
  fi
done

rm -f "$OUT"
tar -czf "$OUT" "${INCLUDE[@]}"

echo "已生成：$OUT"
echo "体积：$(du -h "$OUT" | cut -f1)"
echo
echo "包含的关键文件："
tar -tzf "$OUT" | grep -E 'keystream|lre|server\.js|package\.json' | sed 's/^/  /'
echo
echo "已剔除（体积/安全）：bin/native/linker64、bin/native/lib*.so、bin/native/enc_device、"
echo "                    bin/native/dump*、bin/cloudflared、data/、deploy/、.git/"
