#!/usr/bin/env bash
# FitBridge 备份脚本：Postgres dump + 对象存储目录
#
#   ./scripts/backup.sh [输出目录]
set -euo pipefail

OUT="${1:-./backups}/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

echo "[1/2] 导出 Postgres..."
docker compose exec -T postgres pg_dump -U fitbridge fitbridge | gzip > "$OUT/db.sql.gz"

echo "[2/2] 导出 MinIO 数据卷..."
docker run --rm \
  -v fitbridge_miniodata:/data:ro \
  -v "$(pwd)/$OUT":/out \
  alpine tar czf /out/files.tar.gz -C /data .

echo "完成：$OUT"
echo "  - db.sql.gz    数据库（含凭证密文）"
echo "  - files.tar.gz FIT/GPX 原始文件"
