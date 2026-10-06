#!/usr/bin/env bash
# ==============================================================================
#  口算 PK 私服 · 一键启动 / 上传 GitHub          （Linux · macOS · WSL · Git-Bash）
# ------------------------------------------------------------------------------
#  用法：
#    ./pk.sh               启动私服（等价 ./pk.sh start）
#    ./pk.sh start         启动（后台运行，端口被占自动往后找）
#    ./pk.sh stop          停止
#    ./pk.sh restart       重启
#    ./pk.sh status        查看运行状态
#    ./pk.sh log           跟踪日志（Ctrl-C 退出）
#    ./pk.sh open          浏览器打开管理后台
#    ./pk.sh push [说明]   提交并推送到 GitHub
#    ./pk.sh tag v1.2.3    跑自检 → 打 tag → 推送（触发 CI 出 Release）
#    ./pk.sh all [说明]    启动 + 等待就绪 + 推送
#    ./pk.sh test          只跑自检
#    ./pk.sh help          帮助
#
#  环境变量：
#    PK_PORT=9000     指定端口（被占用会自动往后找 40 个）
#    PK_HOST=127.0.0.1  只监听本机（默认 0.0.0.0，局域网可访问）
#    PK_NO_OPEN=1     启动后不自动开浏览器
#
#  依赖：node ≥ 22、git、bash。不依赖 npm install。
# ==============================================================================

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/run"
LOG="$RUN_DIR/pk-node.log"
PIDFILE="$RUN_DIR/pk-node.pid"
PORTFILE="$RUN_DIR/pk-node.port"
DEFAULT_PORT="${PK_PORT:-8792}"

# ---------- 颜色（非 tty 自动关闭）----------
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'
  C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_OK=''; C_ERR=''; C_WARN=''; C_DIM=''; C_B=''; C_0=''
fi

info()  { printf '%s\n' "$*"; }
ok()    { printf '%s[ok]%s %s\n'   "$C_OK"   "$C_0" "$*"; }
warn()  { printf '%s[!]%s %s\n'    "$C_WARN" "$C_0" "$*"; }
err()   { printf '%s[x]%s %s\n'    "$C_ERR"  "$C_0" "$*" >&2; }
die()   { err "$*"; exit 1; }

mkdir -p "$RUN_DIR"

# ==============================================================================
#  基础工具
# ==============================================================================

need_node() {
  command -v node >/dev/null 2>&1 \
    || die "未找到 node，请先安装 Node.js ≥ 22（https://nodejs.org/）"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 22 ] \
    || die "Node 版本过低（当前 v$(node -v 2>/dev/null | tr -d v)），需要 ≥ 22（用到内置 node:sqlite）"
}

# 进程是否活着
pid_alive() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null | tr -dc '0-9')"
  [ -n "$pid" ] || return 1
  printf '%s' "$pid"
}

is_running() {
  local pid
  pid="$(read_pid)" || return 1
  pid_alive "$pid"
}

# 解析「实际监听端口」。bin/start.js 会在首选端口被占时自动往后找，
# 所以绝不能假定就是 PK_PORT。优先读 PORTFILE（启动时写定），退回扫日志。
detect_port() {
  local p
  if [ -f "$PORTFILE" ]; then
    p="$(tr -dc '0-9' < "$PORTFILE" 2>/dev/null)"
    if [ -n "$p" ] && probe 127.0.0.1 "$p" 2>/dev/null; then
      printf '%s' "$p"
      return 0
    fi
  fi
  [ -f "$LOG" ] || return 1
  p="$(grep -o '已监听 http://[^:]*:[0-9]\{1,5\}' "$LOG" 2>/dev/null | tail -1 | grep -o '[0-9]\{1,5\}$')"
  [ -n "$p" ] || return 1
  printf '%s' "$p" > "$PORTFILE"
  printf '%s' "$p"
}

# HTTP 探活（curl 优先，退化为 bash 的 /dev/tcp）
probe() {
  local host="$1" port="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -sS -o /dev/null -m 3 "http://$host:$port/" >/dev/null 2>&1
    return $?
  fi
  (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1 || return 1
  exec 3<&- 2>/dev/null || true
  return 0
}

open_browser() {
  local url="$1"
  if   command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
  elif command -v open     >/dev/null 2>&1; then open     "$url" >/dev/null 2>&1 &
  elif command -v start    >/dev/null 2>&1; then start    "$url" >/dev/null 2>&1 &
  else return 1
  fi
  return 0
}

# 等日志里出现「已监听」并且端口真能连上。
# 端口只通过 PORTFILE 回传（stdout 保持干净），调用方读 PORTFILE；
# 否则 `port="$(wait_ready)"` 会把函数里的诊断输出一起吞进变量。
wait_ready() {
  local i pid p
  for i in $(seq 1 80); do
    pid="$(read_pid)" || true
    if [ -n "${pid:-}" ] && ! pid_alive "$pid"; then
      err "私服进程已退出，日志尾部："
      tail -n 25 "$LOG" 2>/dev/null | sed 's/^/    /' >&2
      return 1
    fi
    p="$(detect_port)" || true
    if [ -n "${p:-}" ] && probe 127.0.0.1 "$p"; then
      printf '%s' "$p" > "$PORTFILE"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# ==============================================================================
#  start / stop / restart / status / log / open
# ==============================================================================

cmd_start() {
  need_node
  cd "$ROOT" || die "无法进入项目目录：$ROOT"

  if is_running; then
    local p; p="$(detect_port 2>/dev/null || echo "$DEFAULT_PORT")"
    warn "私服已在运行（pid $(read_pid)，端口 $p）"
    info "    如需重启：./pk.sh restart"
    return 0
  fi

  # 每轮启动前把旧日志归档，保证 detect_port 只看到本次的「已监听」
  if [ -s "$LOG" ]; then
    mv -f "$LOG" "$LOG.prev" 2>/dev/null || true
  fi
  : > "$LOG"

  info "${C_B}==> 启动口算 PK 私服${C_0}"
  info "    目录 : $ROOT"
  info "    日志 : $LOG"

  # 后台起：bin/start.js 负责版本校验 / 挑端口 / 打横幅，与 start.sh 完全同源
  nohup node "$ROOT/bin/start.js" >>"$LOG" 2>&1 &
  local pid=$!
  printf '%s' "$pid" > "$PIDFILE"

  # wait_ready 只负责探测，端口经 PORTFILE 回传（它的 stdout 有诊断输出，不能直接捕获）
  if ! wait_ready; then
    err "启动超时（40s）未就绪。"
    [ -f "$LOG" ] && { err "日志尾部："; tail -n 25 "$LOG" | sed 's/^/    /' >&2; }
    return 1
  fi
  local port
  port="$(cat "$PORTFILE" 2>/dev/null | tr -dc '0-9')"
  [ -n "$port" ] || port="$DEFAULT_PORT"

  ok "已启动（pid $pid）"
  printf '%s\n' "${C_DIM}$(sed -n '1,12p' "$LOG" | sed 's/^/    /')${C_0}"

  local url="http://127.0.0.1:$port/"
  info ""
  info "  ${C_B}管理后台:${C_0} $url"

  if [ "${PK_NO_OPEN:-0}" != "1" ]; then
    open_browser "$url" && info "  ${C_DIM}(已尝试打开浏览器)${C_0}" || true
  fi
  info "  ${C_DIM}停止: ./pk.sh stop    日志: ./pk.sh log${C_0}"
}

cmd_stop() {
  local pid port stopped=0

  pid="$(read_pid)" || true
  if [ -n "${pid:-}" ] && pid_alive "$pid"; then
    info "正在停止 pid $pid ..."
    kill "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 30); do
      pid_alive "$pid" || break
      sleep 0.2
    done
    if pid_alive "$pid"; then
      warn "进程未响应，强制结束"
      kill -9 "$pid" 2>/dev/null || true
      sleep 0.3
    fi
    stopped=1
  fi
  rm -f "$PIDFILE"

  # 兜底：pid 文件丢了 / 手动起过 —— 按端口找监听进程
  port="$(detect_port 2>/dev/null || echo "$DEFAULT_PORT")"
  if probe 127.0.0.1 "$port" 2>/dev/null; then
    local leftover
    leftover="$(find_pid_by_port "$port" || true)"
    if [ -n "${leftover:-}" ]; then
      warn "端口 $port 仍被 pid $leftover 占用，一并结束"
      kill "$leftover" 2>/dev/null || true
      sleep 0.5
      pid_alive "$leftover" && kill -9 "$leftover" 2>/dev/null || true
      stopped=1
    fi
  fi

  if [ "$stopped" = "1" ]; then ok "已停止"; else warn "私服本来就没在运行"; fi
  rm -f "$PORTFILE"
}

# Linux 下按端口查监听进程（没有 lsof/ss 也能退化处理）
find_pid_by_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
    return
  fi
  return 0
}

cmd_restart() {
  cmd_stop
  sleep 0.5
  cmd_start
}

cmd_status() {
  cd "$ROOT" || die "无法进入项目目录：$ROOT"
  info "${C_B}pk-node 状态${C_0}"
  printf '    目录      : %s\n' "$ROOT"
  printf '    版本      : %s\n' "$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo '?')"

  local pid
  pid="$(read_pid)" || true
  if [ -n "${pid:-}" ] && pid_alive "$pid"; then
    local port; port="$(detect_port 2>/dev/null || echo '?')"
    printf '    进程      : %s运行中%s (pid %s)\n' "$C_OK" "$C_0" "$pid"
    printf '    监听端口  : %s\n' "$port"
    if [ "$port" != "?" ] && probe 127.0.0.1 "$port"; then
      printf '    健康检查  : %s正常%s  http://127.0.0.1:%s/\n' "$C_OK" "$C_0" "$port"
    else
      printf '    健康检查  : %s无响应%s\n' "$C_WARN" "$C_0"
    fi
  else
    printf '    进程      : %s未运行%s\n' "$C_DIM" "$C_0"
    printf '    启动      : ./pk.sh start\n'
  fi

  # git 概况（不打印 remote，避免泄露 token）
  if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    local branch dirty ahead
    branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    dirty="$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    ahead="$(git -C "$ROOT" rev-list --count '@{u}..HEAD' 2>/dev/null || echo '?')"
    printf '\n    分支      : %s\n' "$branch"
    printf '    未提交    : %s 个文件\n' "$dirty"
    printf '    未推送    : %s 个提交\n' "$ahead"
  fi
}

cmd_log() {
  [ -f "$LOG" ] || die "还没有日志：$LOG（先 ./pk.sh start）"
  info "${C_DIM}跟踪 $LOG —— Ctrl-C 退出${C_0}"
  tail -n 60 -f "$LOG"
}

cmd_open() {
  local port; port="$(detect_port 2>/dev/null || echo "$DEFAULT_PORT")"
  local url="http://127.0.0.1:$port/"
  if open_browser "$url"; then ok "已打开 $url"; else warn "无法自动打开，请手动访问 $url"; fi
}

# ==============================================================================
#  push / tag  —— 上传 GitHub
# ==============================================================================

ensure_git() {
  command -v git >/dev/null 2>&1 || die "未找到 git"
  git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "$ROOT 不是 git 仓库"
  git -C "$ROOT" remote get-url origin >/dev/null 2>&1 || die "未配置 origin 远端"
}

cmd_push() {
  ensure_git
  cd "$ROOT" || die "无法进入项目目录：$ROOT"

  local msg="${1:-}"
  if [ -z "$msg" ]; then
    msg="chore: 同步更新 $(date '+%Y-%m-%d %H:%M')"
  fi

  info "${C_B}==> 提交并上传到 GitHub${C_0}"

  # 安全检查：绝不让运行期数据（含明文 cookie）混进提交
  if [ -d "$ROOT/data" ] && ! git check-ignore -q "$ROOT/data" 2>/dev/null; then
    warn "data/ 未在 .gitignore 中，且含明文登录态！已中止提交。"
    warn "请在 .gitignore 加入 data/ 后重试。"
    return 1
  fi

  git add -A
  if git diff --cached --quiet 2>/dev/null; then
    info "    没有需要提交的改动"
  else
    local n; n="$(git diff --cached --name-only | wc -l | tr -d ' ')"
    info "    待提交 $n 个文件："
    git diff --cached --name-status | head -n 15 | sed 's/^/      /'
    [ "$n" -gt 15 ] && info "      ... 其余 $((n - 15)) 个"
    git commit -q -m "$msg" || die "提交失败"
    ok "已提交：$msg"
  fi

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  info "    推送到 origin/$branch ..."
  if ! git push origin "$branch" 2>&1 | sed 's/^/      /'; then
    die "推送失败（检查网络 / 凭据 / 是否落后远端）"
  fi
  ok "已上传：$(git log -1 --format='%h %s')"
}

cmd_tag() {
  ensure_git
  cd "$ROOT" || die "无法进入项目目录：$ROOT"

  local tag="${1:-}"
  [ -n "$tag" ] || die "用法：./pk.sh tag v1.10.5"
  case "$tag" in
    v[0-9]*) ;;
    *) die "tag 必须以 v 开头且跟版本号，例如 v1.10.5" ;;
  esac

  # 打 tag 会触发 CI 出 Release —— 让用户最后确认一次
  info "${C_B}==> 发布 $tag${C_0}"
  info "    流程：自检 → 打 tag → 推送 → GitHub Actions 自动出 Release"
  if [ "${PK_YES:-0}" != "1" ] && [ -t 0 ]; then
    printf '    确认继续？[y/N] '
    local a; read -r a
    case "$a" in y|Y|yes|YES) ;; *) warn "已取消"; return 1 ;; esac
  fi

  info "    跑自检 ..."
  if ! node "$ROOT/bin/selftest.js" 2>&1 | tail -n 8 | sed 's/^/      /'; then
    die "自检未通过，已中止发布"
  fi

  # 先确保工作区已提交（tag 打在最新提交上）
  if [ -n "$(git status --porcelain)" ]; then
    warn "工作区有未提交改动，先执行一次 push"
    cmd_push "chore: 发布 $tag 前的收尾提交" || die "提交失败，已中止发布"
  fi

  git tag -f "$tag" || die "打 tag 失败"
  git push origin "$tag" -f 2>&1 | sed 's/^/      /' || die "推送 tag 失败"
  ok "已推送 $tag —— CI 正在构建 Release"
  info "    进度：请在仓库 Actions 页查看"
}

# ==============================================================================
#  test / all / help
# ==============================================================================

cmd_test() {
  need_node
  cd "$ROOT" || die "无法进入项目目录：$ROOT"
  info "${C_B}==> 自检${C_0}"
  node "$ROOT/bin/selftest.js"
}

cmd_all() {
  cmd_start || return 1
  info ""
  cmd_push "${1:-}"
}

cmd_help() {
  sed -n '3,24p' "$ROOT/pk.sh" | sed 's/^# \{0,1\}//'
  info ""
  info "  默认端口 ${DEFAULT_PORT}（被占用自动往后找 40 个）；环境变量 PK_PORT / PK_HOST 可改。"
  info "  PK_YES=1 跳过发布确认；PK_NO_OPEN=1 启动后不自动开浏览器。"
}

# ==============================================================================
#  入口
# ==============================================================================

main() {
  local cmd="${1:-start}"
  [ $# -gt 0 ] && shift || true

  case "$cmd" in
    start)          cmd_start "$@" ;;
    stop)           cmd_stop "$@" ;;
    restart)        cmd_restart "$@" ;;
    status|st)      cmd_status "$@" ;;
    log|logs)       cmd_log "$@" ;;
    open)           cmd_open "$@" ;;
    push|upload)    cmd_push "$@" ;;
    tag|release)    cmd_tag "$@" ;;
    test|selftest)  cmd_test "$@" ;;
    all|deploy)     cmd_all "$@" ;;
    help|-h|--help) cmd_help "$@" ;;
    *) err "未知命令：$cmd"; info ""; cmd_help; exit 1 ;;
  esac
}

main "$@"
