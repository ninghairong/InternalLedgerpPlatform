#!/usr/bin/env sh
# 从备份恢复（会覆盖当前数据库！）
# 用法：scripts/restore.sh backups/ledger-20261103-020700.dump [backups/ledger-20261103-020700-attachments.tar.gz]
set -eu
cd "$(dirname "$0")/.."
DUMP=${1:?请指定 .dump 备份文件}
ATT=${2:-}
printf "将用 %s 覆盖当前数据库，输入 yes 确认：" "$DUMP"
read -r ok
[ "$ok" = "yes" ] || { echo "已取消"; exit 1; }
docker compose stop app
docker compose exec -T db psql -U ledger -d postgres -c "DROP DATABASE IF EXISTS ledger WITH (FORCE)" -c "CREATE DATABASE ledger OWNER ledger"
docker compose exec -T db pg_restore -U ledger -d ledger --no-owner < "$DUMP"
if [ -n "$ATT" ]; then
  docker compose run --rm --no-deps -T app sh -c "mkdir -p /data/attachments && tar -xzf - -C /data/attachments" < "$ATT"
fi
docker compose start app
echo "恢复完成"
