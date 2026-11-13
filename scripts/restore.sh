#!/usr/bin/env bash
# 从备份恢复（会覆盖当前数据目录，谨慎执行）
#
#   ./scripts/restore.sh backups/20261113-085300
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${FITBRIDGE_DATA_DIR:-$ROOT/data}"
SRC="${1:?用法: ./scripts/restore.sh <备份目录>}"

[ -f "$SRC/fitbridge-data.tar.gz" ] || { echo "缺少 $SRC/fitbridge-data.tar.gz"; exit 1; }

echo "停止服务前请先停掉 FitBridge。"
read -r -p "将覆盖 $DATA，继续？[y/N] " ans
[ "$ans" = "y" ] || { echo "已取消"; exit 1; }

BACKUP="$(mktemp -d)"
trap 'rm -rf "$BACKUP"' EXIT
tar xzf "$SRC/fitbridge-data.tar.gz" -C "$BACKUP"

rm -rf "$DATA"
mv "$BACKUP/$(basename "$DATA")" "$DATA"

echo "已恢复到 $DATA"
echo "重启服务：npm start"
