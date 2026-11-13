#!/usr/bin/env bash
# 本地启动（无 Docker）
#
#   ./scripts/start.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d node_modules ]; then
  echo "安装依赖..."
  pnpm install
fi

echo "构建..."
pnpm build

echo "启动（Ctrl+C 停止）"
exec node apps/server/dist/index.js
