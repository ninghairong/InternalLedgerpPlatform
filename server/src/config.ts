import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 源码运行时为 server/src，打包后为 server/dist，两者向上两级都是仓库根目录
const root = path.resolve(here, '../..');

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5433/ledger',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin123',
  migrationsDir: process.env.MIGRATIONS_DIR ?? path.join(root, 'db/migrations'),
  attachmentDir: process.env.ATTACHMENT_DIR ?? path.join(root, 'data/attachments'),
  backupDir: process.env.BACKUP_DIR ?? path.join(root, 'data/backups'),
  webDir: process.env.WEB_DIR ?? path.join(root, 'web/dist'),
  maxUploadBytes: 20 * 1024 * 1024,
  staleDays: 30,
  backupKeepDays: 30,
};
