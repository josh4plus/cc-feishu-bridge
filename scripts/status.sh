#!/usr/bin/env bash
# 看桥接是否在跑、连没连上、最近发生了什么
set -uo pipefail

cd "$(dirname "$0")/.."
PIDFILE="scripts/.bridge.pid"

echo "== 进程 =="
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  PID="$(cat "$PIDFILE")"
  echo "在跑，PID $PID"
  ps -o pid,etime,command -p "$PID" | tail -n +2
  echo
  echo "== claude 子进程 =="
  pgrep -P "$PID" -l 2>/dev/null || echo "（暂无，收到消息时才会有）"
else
  echo "没在跑"
fi

echo
echo "== 长连接状态（日志最后 15 行） =="
LOG="logs/bridge-$(date +%F).log"
[ -f "$LOG" ] && tail -15 "$LOG" || echo "（今天还没有日志）"
