#!/usr/bin/env bash
# 停止桥接（同时结束它拉起的 claude 子进程）
set -uo pipefail

cd "$(dirname "$0")/.."
PIDFILE="scripts/.bridge.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "没有 PID 文件，可能没在跑。找一下：ps aux | grep bridge.mjs"
  exit 0
fi

PID="$(cat "$PIDFILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "进程 $PID 已经不在了，清掉 PID 文件"
  rm -f "$PIDFILE"
  exit 0
fi

# 先停子进程再停父进程，避免 claude 变成孤儿
pkill -P "$PID" 2>/dev/null || true
kill "$PID" 2>/dev/null || true

for _ in 1 2 3 4 5; do
  sleep 1
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "✓ 已停止"
    exit 0
  fi
done

kill -9 "$PID" 2>/dev/null || true
rm -f "$PIDFILE"
echo "✓ 已强制停止"
