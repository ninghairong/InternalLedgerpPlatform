#!/usr/bin/env sh
# 手动备份：数据库（pg_dump 自定义格式）+ 附件目录，输出到 ./backups/
# 用法：scripts/backup.sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M%S)
docker compose exec -T db pg_dump -U ledger -d ledger -Fc > "backups/ledger-$STAMP.dump"
docker compose exec -T app tar -czf - -C /data/attachments . > "backups/ledger-$STAMP-attachments.tar.gz" 2>/dev/null || echo "（附件目录为空或 app 未运行，已跳过附件）"
echo "已生成 backups/ledger-$STAMP.dump"
