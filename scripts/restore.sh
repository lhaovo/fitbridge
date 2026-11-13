#!/usr/bin/env bash
# 从备份恢复（会覆盖当前数据，谨慎执行）
#
#   ./scripts/restore.sh backups/20261113-083000
set -euo pipefail

SRC="${1:?用法: ./scripts/restore.sh <备份目录>}"
[ -f "$SRC/db.sql.gz" ] || { echo "缺少 $SRC/db.sql.gz"; exit 1; }

echo "恢复数据库..."
gunzip -c "$SRC/db.sql.gz" | docker compose exec -T postgres psql -U fitbridge -d fitbridge

if [ -f "$SRC/files.tar.gz" ]; then
  echo "恢复文件..."
  docker run --rm \
    -v fitbridge_miniodata:/data \
    -v "$(pwd)/$SRC":/src:ro \
    alpine sh -c 'rm -rf /data/* && tar xzf /src/files.tar.gz -C /data'
fi

echo "完成。请重启服务：docker compose restart server"
