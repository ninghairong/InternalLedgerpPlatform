import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';
import type { Sql } from './db';

/** 按文件名顺序执行 db/migrations/*.sql，已执行的记录在 schema_migrations 中 */
export async function migrate(sql: Sql, dir = config.migrationsDir, log: (m: string) => void = console.log) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const text = await fs.readFile(path.join(dir, f), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations(name) VALUES (${f})`;
    });
    log(`applied migration ${f}`);
  }
}
