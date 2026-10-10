#!/usr/bin/env bash
# 端到端验证：DELETE /api/leo/accounts/:id 是否**先发包退登**。
#
# 用 ?keepLocal=1 只验退登、保留本地记录（便于反复验证）。
# 判据：响应里 loggedOut.attempts 两条链路都有状态码，且至少一条 200。
set -u
BASE="${BASE:-http://127.0.0.1:8792}"
ACC="${1:-38}"
U="${PK_ADMIN_USER:-admin}"
P="${PK_ADMIN_PASS:-admin}"

echo "=== 1) 登录取 token ==="
# 注意：pk-node 的登录把会话放在 **Set-Cookie** 里（body 只有 {ok,user}），
# 所以后面要用 cookie jar，不能只取 body.token。
JAR=$(mktemp)
LOGIN=$(curl -s -c "$JAR" -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}")
echo "  登录响应: $(echo "$LOGIN" | head -c 120)"
echo "  cookie: $(grep -c . "$JAR" 2>/dev/null || echo 0) 行"
TOKEN=$(echo "$LOGIN" | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d.get("data") or {}).get("token") or d.get("token") or "")' 2>/dev/null)

echo
echo "=== 2) 退登前身份 ==="
curl -s -b "$JAR" "$BASE/api/leo/accounts/$ACC/identity" | head -c 200
echo

echo
echo "=== 3) DELETE（keepLocal=1，只退登不删记录）==="
RESP=$(curl -s -b "$JAR" -X DELETE "$BASE/api/leo/accounts/$ACC?keepLocal=1")
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"

echo
echo "=== 4) 判定 ==="
echo "$RESP" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("  解析失败:", e); raise SystemExit(0)
lo = d.get("loggedOut") or {}
att = lo.get("attempts") or []
if not att:
    print("  ❌ 没有发包记录 —— 仍是本地删！")
else:
    print("  发包 %d 条链路:" % len(att))
    for a in att:
        st = a.get("status")
        print("    %-5s %-34s → %s%s" % (a.get("host"), a.get("path"), st,
              "" if not a.get("error") else ("  异常: " + str(a.get("error")))))
    ok = [a for a in att if a.get("status") == 200]
    print("  ✅ 有 %d/%d 条返回 200 → 确实发包退登了" % (len(ok), len(att)) if ok
          else "  ⚠️ 发包了但无 200（看上面的状态码）")
print("  keepLocal =", d.get("keepLocal"), "（true 表示本地记录未删）")
'