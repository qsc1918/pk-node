#!/usr/bin/env bash
# 准备 **Android 版** cloudflared —— 下载后解包、去 Termux 路径、放到指定位置。
#
# ============================================================================
# 为什么不用官方 `cloudflared-linux-arm64`（2026-10-05 定案，实测）
# ============================================================================
#
# 官方 GitHub Releases 的 `cloudflared-linux-arm64` 是 **`GOOS=linux` 静态链接**：
#
#   · 无 dynamic section（`readelf -d` 为空）→ 纯 Go 运行时，自带一切；
#   · DNS 走 **Go 自己的 resolver**，它**只读 `/etc/resolv.conf`**；
#   · 而 Android **没有 `/etc/resolv.conf`**（`/etc` 是 `/system/etc` 只读软链，
#     且 `/` 是 erofs 只读 —— 连 root 都 remount 不了，已真机实测）；
#   · Go 也**不读** Android 的 `net.dns*` 属性（那是 bionic/netd 的机制）；
#   · ⇒ 它退化到「查本机 :53」，而 netd 不在那监听 ⇒
#     `lookup api.trycloudflare.com on [::1]:53: connection refused`。
#
# 试过、**全部失败**的方案（别再走一遍）：
#   ① 写 `/etc/resolv.conf` —— 只读分区，写不进去；
#   ② `--dns-resolver-addrs` / `TUNNEL_DNS_RESOLVER_ADDRS` —— 只作用于
#      `tunnel run`（命名隧道），**对 quick tunnel 无效**（已实测）；
#   ③ `HTTPS_PROXY` + 自建 CONNECT 代理 —— cloudflared **不遵循任何代理环境变量**
#      （给它一个必然连不上的坏代理，它照样成功 ⇒ 那条代码路径没走）。
#
# ============================================================================
# 正解：Termux 的 `GOOS=android` 构建
# ============================================================================
#
# Termux 打包的 cloudflared 是 **`CGO_ENABLED=1 GOOS=android`** 构建，特征：
#
#   · `readelf -l` → `[Requesting program interpreter: /system/bin/linker64]`
#     （**Android 原生 linker**，不是静态的）；
#   · `NEEDED`：`liblog.so` / `libdl.so` / `libc.so` —— **全是系统库**，App 天生能加载；
#   · DNS 走 **bionic 的 `getaddrinfo`** → 通过 **netd 的 `dnsproxyd` socket**
#     （`/dev/socket/dnsproxyd`，属 `inet` 组 —— **所有 App 都在这个组里**）；
#   · ⇒ **不需要 root、不需要改系统文件、任何设备都能用**。
#
# 这正是「Termux 里不 root 也能用」的原因（用户原话点破的关键）。
#
# ## 唯一需要处理的：RUNPATH
#
# Termux 的 deb 里，二进制带
# `RUNPATH = /data/data/com.termux/files/usr/lib`（指向 Termux 私有目录，
# 普通 App 读不到）。而我们**只依赖 3 个系统库**，所以直接
# **清空 RUNPATH**（用 `patchelf --set-rpath ''`）→ 完全独立，不依赖 Termux。
#
# ============================================================================
# 用法
# ============================================================================
#
#   sh bin/get-cloudflared.sh                    # → bin/cloudflared
#   DEST=app/.../jniLibs/arm64-v8a/libcloudflared.so sh bin/get-cloudflared.sh
#
# 需要 `curl` + `ar`（binutils）+ `xz` + `patchelf`。
# 在 CI（ubuntu-latest）上都有，缺的话一行 apt 装好。

set -u

cd "$(dirname "$0")/.."
DEST="${DEST:-bin/cloudflared}"

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) TERMUX_ARCH="aarch64" ;;
  x86_64|amd64)  TERMUX_ARCH="x86_64" ;;
  armv7l|armv7)  TERMUX_ARCH="arm" ;;
  *) echo "未知架构：$ARCH" >&2; exit 1 ;;
esac

BASE="https://packages.termux.dev/apt/termux-main"
DEB_URL="${DEB_URL:-}"

# ---------------------------------------------------------------- ① 找最新版本
if [ -z "$DEB_URL" ]; then
  echo "== 查询 Termux 源里的 cloudflared 版本 =="
  PKGS="$(curl -fsSL --retry 3 "$BASE/dists/stable/main/binary-$TERMUX_ARCH/Packages" 2>/dev/null || true)"
  LINE="$(printf '%s\n' "$PKGS" | grep -A 6 '^Package: cloudflared$' | grep -E '^(Version|Filename|Size):' || true)"
  VER="$(printf '%s\n' "$LINE" | sed -n 's/^Version: //p' | head -1)"
  FILE="$(printf '%s\n' "$LINE" | sed -n 's/^Filename: //p' | head -1)"
  SIZE="$(printf '%s\n' "$LINE" | sed -n 's/^Size: //p' | head -1)"
  if [ -z "$FILE" ]; then
    echo "查询失败（网络问题？）。可手动指定 DEB_URL=... 重试" >&2
    exit 1
  fi
  echo "  版本：$VER（约 $(( ${SIZE:-0} / 1024 )) KB 压缩）"
  DEB_URL="$BASE/$FILE"
fi

# ---------------------------------------------------------------- ② 下载 + 解包
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "== 下载 $DEB_URL"
curl -fL --retry 3 --retry-delay 2 -o "$TMP/cf.deb" "$DEB_URL" || { echo "下载失败" >&2; exit 1; }

echo "== 解包"
( cd "$TMP" && ar x cf.deb ) 2>/dev/null || { echo "需要 \`ar\`（binutils）" >&2; exit 1; }
tar -xf "$TMP/data.tar.xz" -C "$TMP" 2>/dev/null || { echo "需要 xz 支持" >&2; exit 1; }
SRC="$TMP/data/data/com.termux/files/usr/bin/cloudflared"
[ -f "$SRC" ] || { echo "deb 里没找到 cloudflared 二进制" >&2; exit 1; }

# ---------------------------------------------------------------- ③ 去 Termux 路径
echo "== 去掉 Termux RUNPATH（只依赖系统库 liblog/libdl/libc）"
mkdir -p "$(dirname "$DEST")"
cp "$SRC" "$DEST"
if command -v patchelf >/dev/null 2>&1; then
  patchelf --set-rpath '' "$DEST"
  echo "   RUNPATH 已清空"
else
  echo "   ⚠ 没有 patchelf（保留原 RUNPATH，指向 Termux 私有目录）。" >&2
  echo "     装一下：apt-get install -y patchelf" >&2
fi
chmod +x "$DEST"

# ---------------------------------------------------------------- ④ 自检
echo "== 自检"
if command -v readelf >/dev/null 2>&1; then
  echo "   解释器：$(readelf -l "$DEST" 2>/dev/null | grep -o '/system/bin/linker64' | head -1)"
  echo "   依赖：$(readelf -d "$DEST" 2>/dev/null | grep NEEDED | sed 's/.*\[\(.*\)\]/\1/' | tr '\n' ' ')"
fi
echo "完成：$DEST"
echo
echo "  这份是 **GOOS=android** 构建，DNS 走 bionic → netd，Android 上可直接跑。"
echo "  （官方 cloudflared-linux-* 是 GOOS=linux，在 Android 上因读不到"
echo "    /etc/resolv.conf 而必然 DNS 失败 —— 别换回去。）"