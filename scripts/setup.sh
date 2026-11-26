#!/usr/bin/env bash
# 一次性安装：检查环境 → 装依赖 → 生成 config.json
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "==> 检查 Node"
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没找到 node。装 Node 20 以上：https://nodejs.org/ 或 brew install node"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node 版本太低（$(node -v)），要 20 以上"
  exit 1
fi
echo "✓ node $(node -v)"

echo "==> 检查 claude"
# GUI/后台启动时 PATH 常常不含用户级 bin，这里补上最常见的几个位置
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
if command -v claude >/dev/null 2>&1; then
  echo "✓ claude -> $(command -v claude)"
  echo "   （已写进 config.json 的 claudeBin，用绝对路径避免后台启动找不到）"
  CLAUDE_ABS="$(command -v claude)"
else
  echo "⚠ 没找到 claude 命令。装好 Claude Code 后再把 config.json 的 claudeBin 改成它的绝对路径"
  CLAUDE_ABS="claude"
fi

echo "==> 安装依赖"
npm install --omit=dev

echo "==> 生成 config.json"
if [ -f config.json ]; then
  echo "config.json 已存在，跳过（不覆盖你的凭证）"
else
  cp config.example.json config.json
  chmod 600 config.json
  # 用 node 安全地改 JSON，不依赖 jq
  CLAUDE_ABS="$CLAUDE_ABS" node -e '
    const fs = require("fs");
    const p = "config.json";
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    if (process.env.CLAUDE_ABS && process.env.CLAUDE_ABS !== "claude") c.claudeBin = process.env.CLAUDE_ABS;
    fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
  '
  echo "✓ 已生成 config.json（权限 600）"
fi

echo
echo "接下来："
echo "  1. 编辑 config.json，填 appId / appSecret"
echo "  2. node probe.mjs，在飞书里给机器人发一条消息，拿到你的 open_id"
echo "  3. 把 open_id 填进 allowedOpenIds"
echo "  4. ./scripts/start.sh"
