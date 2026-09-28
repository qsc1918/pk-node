#!/system/bin/sh
# 从本机小猿 App 里导出设备链（ks_*），输出可直接粘贴到 pk-node「设备链池」。
#
# 用法（需 root）：
#   sh pull-device-chain.sh            # 读 mmkv/cookie_store
#   sh pull-device-chain.sh <文件>      # 读指定文件（例如从别的机器拷来的 cookie_store）
#
# 原理：App 的 cookie 落在 mmkv `cookie_store`（JSON 数组，含 ks_deviceid/ks_r/ks_u/ks_sess/ks_persistent）。
# 注意：只导出 ks_*，不含 sess/userid（避免把登录态带到别处）。
set -u
D=/data/data/com.fenbi.android.leo
SRC="${1:-$D/files/mmkv/cookie_store}"

if [ ! -f "$SRC" ]; then
  echo "找不到 $SRC（需要 root；或传一个 cookie_store 路径）" >&2
  exit 1
fi

# 用 sed 把 \\u003d 还原成 '='，再按 ks_ 名抓 value。
OUT=$(cat "$SRC" | sed 's/\\u003d/=/g' | grep -o '"name":"ks_[a-z_]*","path":"[^"]*","persistent":[a-z]*,"secure":[a-z]*,"value":"[^"]*"' 2>/dev/null)

if [ -z "$OUT" ]; then
  # 兜底：换一种字段顺序
  OUT=$(cat "$SRC" | sed 's/\\u003d/=/g' | grep -o '"name":"ks_[a-z_]*"[^}]*"value":"[^"]*"' 2>/dev/null)
fi

echo "$OUT" | sed -E 's/.*"name":"(ks_[a-z_]+)".*"value":"([^"]*)".*/\1=\2/' | sort -u
