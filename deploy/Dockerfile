# pk-node 云端镜像（Cloudflare Containers）
#
# 要求：linux/amd64（Cloudflare Containers 的硬要求），Node >= 22（用到内置 node:sqlite）。
# 说明：本镜像**只装运行时必需**，不带测试/文档；data/ 不入镜像（运行时从 R2 恢复）。

FROM --platform=linux/amd64 node:24-bookworm-slim

# 系统 gzip 是「按设备口径压缩」的首选（level 6 / 无 mtime / OS 字段 0xff），
# 缺了会回落 Node zlib（仍可用，但字节与真机不同 —— 内容编码只做 XOR，不影响正确性）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends gzip ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 只拷贝运行时需要的部分（避免把 .git / dist / 测试产物带进镜像）
COPY package.json ./
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY bin/ ./bin/
COPY tools/ ./tools/
COPY deploy/ ./deploy/

# ⚠️ bin/cloudflared 是 36MB 穿透客户端，容器里用不到（Cloudflare 本身就是公网入口）
RUN rm -f bin/cloudflared \
 && mkdir -p data

# 容器内监听 0.0.0.0，端口固定 8792（与本地一致）
ENV PK_HOST=0.0.0.0 \
    PK_PORT=8792 \
    PK_DB=/app/data/pk-node.sqlite \
    NODE_ENV=production

EXPOSE 8792

# tini 做 init：正确处理 SIGTERM（Cloudflare 停实例前会发 SIGTERM，我们要用它做 DB 备份）
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/entrypoint.sh"]