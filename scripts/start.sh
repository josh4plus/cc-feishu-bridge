#!/usr/bin/env bash
# 后台启动桥接，日志在 logs/bridge-YYYY-MM-DD.log
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PIDFILE="scripts/.bridge.pid"

if [ ! -f config.json ]; then
  echo "✗ 没有 config.json。先跑 ./scripts/setup.sh"
  exit 1
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "已经在跑了，PID $(cat "$PIDFILE")。要重启先 ./scripts/stop.sh"
  exit 0
fi

# 关键：后台进程的 PATH 里常常没有用户级 bin，claude 会找不到
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

mkdir -p "$ROOT/logs"

nohup node "$ROOT/bridge.mjs" >> "$ROOT/logs/launch.out" 2>&1 &
echo $! > "$PIDFILE"

sleep 2
if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "✓ 已启动 PID $(cat "$PIDFILE")"
  echo "  日志：$ROOT/logs/launch.out"
  echo "  看有没有连上：tail -f $ROOT/logs/launch.out"
else
  echo "✗ 启动失败，看日志："
  tail -20 "$ROOT/logs/launch.out" 2>/dev/null || true
  rm -f "$PIDFILE"
  exit 1
fi
