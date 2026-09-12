#!/bin/sh
# 重启 dsh web，让新装的插件生效。
#
# 用法：sh scripts/restart-web.sh [延迟秒数]
# 延迟的意义：先让当前会话把回复刷进日志，再动手杀进程。
#
# 流程：预检启动命令 → 杀旧进程 → 用 launchd 托管新进程 → 等端口可访问。
# 结果写到 $ROOT/.dsh-updater-restart.status，日志写到 $ROOT/.dsh-updater-restart.log。
#
# 教训（v0.1.1 修）：`launchctl submit` 不继承调用者的环境。dsh 是
# `#!/usr/bin/env node` 脚本，在 launchd 的极简 PATH 下会直接以
# `env: node: No such file or directory` 退出 127 —— 于是旧进程已杀、
# 新进程起不来，dsh 就"挂掉"了。
# 现在先解析出 dsh 真正的 JS 入口，用绝对路径的 node 直接跑，完全不看 PATH；
# 并且预检不过就绝不碰旧进程。
set -u

DELAY="${1:-45}"
PORT=3080
ROOT="${DSH_WEB_ROOT:-$HOME}"
CHECK_ONLY=0
if [ "$DELAY" = "--check" ]; then
  CHECK_ONLY=1
  DELAY=0
fi

# 从 launchd 之类的精简环境启动时，PATH 里没有 node/homebrew，需要自己补齐。
PATH="/Users/heshuren/.nvm/versions/node/v24.18.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PATH

LOG="$ROOT/.dsh-updater-restart.log"
STATUS="$ROOT/.dsh-updater-restart.status"

fail() {
  echo "failed: $1 $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS"
  echo "[restart-web] 中止：$1" >> "$LOG"
  exit 1
}

sleep "$DELAY"

# ---- 预检：在完全不动现有进程的前提下，确认新进程真的能起来 ----
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || fail "PATH 里找不到 node"
"$NODE_BIN" --version >/dev/null 2>&1 || fail "node 不可执行：$NODE_BIN"

DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
[ -n "$DSH_BIN" ] || fail "PATH 里找不到 dsh"
DSH_ENTRY="$("$NODE_BIN" -e 'const fs=require("fs");process.stdout.write(fs.realpathSync(process.argv[1]))' "$DSH_BIN" 2>/dev/null || true)"
[ -n "$DSH_ENTRY" ] || fail "无法解析 dsh 的 JS 入口：$DSH_BIN"
[ -f "$DSH_ENTRY" ] || fail "dsh 入口不存在：$DSH_ENTRY"
"$NODE_BIN" "$DSH_ENTRY" --version >/dev/null 2>&1 || fail "预检启动失败：$NODE_BIN $DSH_ENTRY --version"

# 预检全过，下面才开始动现有进程。
QUOTED_ROOT="$(printf '%s' "$ROOT" | sed "s/'/'\\\\''/g")"
LAUNCH="cd '$QUOTED_ROOT' && exec \"$NODE_BIN\" \"$DSH_ENTRY\" web --no-open >>\"$LOG\" 2>&1"

if [ "$CHECK_ONLY" = "1" ]; then
  echo "预检通过"
  echo "  node : $NODE_BIN"
  echo "  dsh  : $DSH_BIN"
  echo "  entry: $DSH_ENTRY"
  echo "  root : $ROOT"
  echo "  launch: $LAUNCH"
  exit 0
fi

OLD_PID="$(lsof -ti ":$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
if [ -n "$OLD_PID" ]; then
  kill "$OLD_PID" 2>/dev/null || true
  count=0
  while kill -0 "$OLD_PID" 2>/dev/null && [ "$count" -lt 100 ]; do
    count=$((count + 1))
    sleep 0.1
  done
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill -9 "$OLD_PID" 2>/dev/null || true
    sleep 0.5
    if kill -0 "$OLD_PID" 2>/dev/null; then
      fail "旧进程 $OLD_PID 杀不掉，不启动第二个实例"
    fi
  fi
fi

: >> "$LOG"
echo "[restart-web] 于 $(date -u +%Y-%m-%dT%H:%M:%SZ) 重启（旧 pid=${OLD_PID:-none}）" >> "$LOG"

# 优先让 launchd 托管：本脚本自己可能就是被 launchd 拉起的作业，
# 若新进程只是它的后台子进程，作业结束时会被一起回收。
if command -v launchctl >/dev/null 2>&1; then
  launchctl remove dsh-web 2>/dev/null || true
  if ! launchctl submit -l dsh-web -- /bin/sh -c "export PATH=\"$PATH\"; $LAUNCH"; then
    fail "launchctl submit 失败"
  fi
else
  nohup /bin/sh -c "$LAUNCH" &
  echo $! > "$ROOT/.dsh-updater-restart.pid"
fi

count=0
while [ "$count" -lt 300 ]; do
  if curl -sS -o /dev/null "http://127.0.0.1:$PORT/" 2>>"$LOG"; then
    echo "ready $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS"
    exit 0
  fi
  count=$((count + 1))
  sleep 0.2
done

fail "等了 60 秒端口 $PORT 还没起来，看 $LOG"
