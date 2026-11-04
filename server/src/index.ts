import { buildApp } from './app';
import { config } from './config';
import { sql } from './db';
import { migrate } from './migrate';
import { ensureBaseData } from './bootstrap';
import { scheduleDaily } from './services/system';

const log = (m: string) => console.log(`[ledger] ${m}`);

await migrate(sql, undefined, log);
await ensureBaseData(sql, log);
const app = await buildApp(sql, { logger: process.env.NODE_ENV === 'production' });
scheduleDaily(sql, log);
await app.listen({ port: config.port, host: '0.0.0.0' });
log(`listening on :${config.port}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await sql.end();
    process.exit(0);
  });
}
