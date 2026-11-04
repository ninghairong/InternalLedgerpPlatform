// 数据自检与备份。自检每天运行一次，结果写审计日志；备份用 pg_dump 生成到备份目录，保留 30 天。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { balances } from '@ledger/shared/selectors';
import { centsFromDecimal } from '@ledger/shared/format';
import { config } from '../config';
import type { Sql } from '../db';
import { audit, type Actor } from '../audit';
import { badRequest } from '../errors';
import { loadSnapshot } from '../snapshot';

const run = promisify(execFile);

export interface CheckItem {
  name: string;
  ok: boolean;
  detail: string[];
}

export async function selfCheck(sql: Sql): Promise<{ at: string; ok: boolean; items: CheckItem[] }> {
  const [bal, lots, alloc] = await Promise.all([
    sql`SELECT name, cached, ledger_total FROM v_check_balance`,
    sql`SELECT name, balance, lot_total FROM v_check_lots`,
    sql`SELECT flow_no, amount, allocated FROM v_check_allocation`,
  ]);
  // 独立再算一遍：由流水推出的余额应与数据库余额一致
  const snap = await loadSnapshot(sql, { fresh: true });
  const computed = balances(snap.flows);
  const dbBal = await sql`SELECT account_id::text AS id, balance FROM account_balance`;
  const recompute = dbBal.filter((r) => centsFromDecimal(r.balance) !== (computed.get(r.id) ?? 0)).map((r) => {
    const a = snap.accounts.find((x) => x.id === r.id);
    return `${a?.name}：数据库 ${r.balance}，按流水重算 ${((computed.get(r.id) ?? 0) / 100).toFixed(2)}`;
  });
  const items: CheckItem[] = [
    { name: '账户余额 = 分录合计', ok: !bal.length, detail: bal.map((r) => `${r.name}：余额 ${r.cached}，分录合计 ${r.ledger_total}`) },
    { name: '溯源账户余额 = 未用完入款合计', ok: !lots.length, detail: lots.map((r) => `${r.name}：余额 ${r.balance}，未用完入款 ${r.lot_total}`) },
    { name: '每笔出款的资金来源合计 = 金额', ok: !alloc.length, detail: alloc.map((r) => `${r.flow_no}：金额 ${r.amount}，来源 ${r.allocated}`) },
    { name: '按流水重算余额与数据库一致', ok: !recompute.length, detail: recompute },
  ];
  return { at: new Date().toISOString(), ok: items.every((i) => i.ok), items };
}

const dbArgs = () => {
  const u = new URL(config.databaseUrl);
  return { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }, args: ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username), '-d', u.pathname.slice(1)] };
};

export async function createBackup(sql: Sql, actor?: Actor) {
  await fs.mkdir(config.backupDir, { recursive: true });
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const file = path.join(config.backupDir, `ledger-${stamp}.dump`);
  const { env, args } = dbArgs();
  try {
    await run('pg_dump', [...args, '-Fc', '-f', file], { env });
  } catch (e) {
    throw badRequest(`备份失败：${(e as Error).message}（应用容器内需要 pg_dump；本地开发可用 scripts/backup.sh）`);
  }
  // 附件目录一并打包
  const attTar = file.replace(/\.dump$/, '-attachments.tar.gz');
  try {
    await fs.mkdir(config.attachmentDir, { recursive: true });
    await run('tar', ['-czf', attTar, '-C', config.attachmentDir, '.']);
  } catch {
    /* 附件目录为空或 tar 不可用时只保留数据库备份 */
  }
  await cleanupBackups();
  const size = (await fs.stat(file)).size;
  await audit(sql, actor, 'backup.create', 'SYSTEM', null, `生成备份 ${path.basename(file)}（${(size / 1024).toFixed(0)} KB）`);
  return path.basename(file);
}

async function cleanupBackups() {
  const files = await fs.readdir(config.backupDir).catch(() => [] as string[]);
  const cutoff = Date.now() - config.backupKeepDays * 86400000;
  for (const f of files) {
    const p = path.join(config.backupDir, f);
    const st = await fs.stat(p);
    if (st.mtimeMs < cutoff) await fs.rm(p);
  }
}

export async function listBackups() {
  const files = await fs.readdir(config.backupDir).catch(() => [] as string[]);
  const out = [];
  for (const f of files.filter((x) => x.startsWith('ledger-')).sort().reverse()) {
    const st = await fs.stat(path.join(config.backupDir, f));
    out.push({ name: f, size: st.size, at: st.mtime.toISOString() });
  }
  return out;
}

export function backupPath(name: string) {
  if (!/^ledger-[\w-]+\.(dump|tar\.gz)$/.test(name)) throw badRequest('无效的备份文件名');
  return path.join(config.backupDir, name);
}

/** 每日任务：自检 + 备份（应用内定时器；5 人规模无需外部调度） */
export function scheduleDaily(sql: Sql, log: (m: string) => void) {
  const tick = async () => {
    try {
      const r = await selfCheck(sql);
      await audit(sql, undefined, 'system.selfCheck', 'SYSTEM', null, r.ok ? '每日自检通过' : `每日自检发现问题：${r.items.filter((i) => !i.ok).map((i) => i.name).join('、')}`, r);
      log(`self-check ${r.ok ? 'ok' : 'FAILED'}`);
      if (process.env.AUTO_BACKUP !== 'false') log(`backup ${await createBackup(sql)}`);
    } catch (e) {
      log(`daily task failed: ${(e as Error).message}`);
    }
  };
  // 每天凌晨 2 点左右
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 7, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    tick();
    setInterval(tick, 86400000).unref();
  }, next.getTime() - now.getTime()).unref();
}
