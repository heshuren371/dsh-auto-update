#!/bin/sh
# 重启 dsh web，让新装的插件生效。
#
# 用法：sh scripts/restart-web.sh [延迟秒数]
# 延迟的意义：先让当前会话把回复刷进日志，再动手杀进程。
#
# 找到正在监听 3080 的进程 → 杀掉 → 用同一个 dsh 入口重新拉起 → 等待端口可访问。
# 结果写到 $ROOT/.dsh-updater-restart.status，日志写到 $ROOT/.dsh-updater-restart.log。
set -u

DELAY="${1:-45}"
PORT=3080
ROOT="${DSH_WEB_ROOT:-$HOME}"
DSH_BIN="${DSH_BIN:-$(command -v dsh)}"
LOG="$ROOT/.dsh-updater-restart.log"
STATUS="$ROOT/.dsh-updater-restart.status"

sleep "$DELAY"

if [ -z "$DSH_BIN" ]; then
  echo "failed: dsh 不在 PATH 上 $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS"
  exit 1
fi

OLD_PID="$(lsof -ti ":$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
if [ -n "$OLD_PID" ]; then
  kill "$OLD_PID" 2>/dev/null || true
  count=0
  while kill -0 "$OLD_PID" 2>/dev/null && [ "$count" -lt 100 ]; do
    count=$((count + 1))
    sleep 0.1
  done
  kill -9 "$OLD_PID" 2>/dev/null || true
fi

: > "$LOG"
cd "$ROOT" || exit 1
nohup "$DSH_BIN" web --no-open >>"$LOG" 2>&1 &
echo $! > "$ROOT/.dsh-updater-restart.pid"

count=0
while [ "$count" -lt 300 ]; do
  if curl -sS -o /dev/null "http://127.0.0.1:$PORT/" 2>>"$LOG"; then
    echo "ready $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS"
    exit 0
  fi
  count=$((count + 1))
  sleep 0.2
done

echo "failed $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS"
exit 1
