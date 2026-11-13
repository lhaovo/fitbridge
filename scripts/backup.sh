#!/usr/bin/env bash
# FitBridge 备份（SQLite 单体版）
#
# 整个 FitBridge 的状态 = 数据目录，所以备份就是打包数据目录。
#   ./scripts/backup.sh [输出目录]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${FITBRIDGE_DATA_DIR:-$ROOT/data}"
OUT="${1:-$ROOT/backups}/$(date +%Y%m%d-%H%M%S)"

mkdir -p "$OUT"

echo "[1/2] 打包数据目录: $DATA"
tar czf "$OUT/fitbridge-data.tar.gz" -C "$(dirname "$DATA")" "$(basename "$DATA")"

echo "[2/2] 导出可读的 SQLite dump（便于人工检查）"
if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DATA/fitbridge.db" ]; then
  sqlite3 "$DATA/fitbridge.db" ".dump" > "$OUT/db.sql"
  echo "  - db.sql"
else
  echo "  (跳过：未安装 sqlite3 或数据库文件不存在)"
fi

echo "完成：$OUT"
echo "  - fitbridge-data.tar.gz  含 SQLite + blobs + master.key"
echo
echo "注意：master.key 是凭证解密主密钥，丢了已有的平台凭证就解不开了。"
