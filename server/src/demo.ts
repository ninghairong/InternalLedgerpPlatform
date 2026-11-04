// 演示数据：把 shared/seed.ts 的模拟数据经由正式的业务函数写入（与真实录入走同样的校验与触发器）。
import * as seed from '@ledger/shared/seed';
import type { Sql } from './db';
import type { Actor } from './audit';
import { ensureBaseData } from './bootstrap';
import { hashPassword } from './password';
import { invalidate } from './snapshot';
import { createFlows } from './services/flows';
import { addTaxProfile, createAccount, createEntity, createProject, saveInvoice } from './services/master';

export async function resetDatabase(sql: Sql) {
  const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`;
  await sql.unsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await sql`ALTER SEQUENCE flow_no_seq RESTART`;
}

export async function loadDemo(sql: Sql, log: (m: string) => void = console.log) {
  await ensureBaseData(sql, log);
  const [admin] = await sql`SELECT id::text, username, display_name FROM app_user WHERE role = 'ADMIN' ORDER BY id LIMIT 1`;
  const actor: Actor = { id: admin.id, username: admin.username, displayName: admin.display_name, role: 'ADMIN' };
  await sql.begin(async (tx) => {
    const idMap = new Map<string, string>();
    // 主体：先总公司 / 独立公司，再分公司
    for (const e of [...seed.entities].sort((a, b) => Number(a.kind === 'BRANCH') - Number(b.kind === 'BRANCH'))) {
      const id = await createEntity(tx, { ...e, parentId: e.parentId ? idMap.get(e.parentId) : undefined }, e.taxProfiles[0], actor);
      idMap.set(e.id, id);
      // 有身份变更历史的主体（如中汉夏河 2026 年起转为一般纳税人）逐条补录
      for (const p of e.taxProfiles.slice(1)) await addTaxProfile(tx, id, p, actor, false);
      const [common] = await tx`SELECT id::text FROM project WHERE entity_id = ${id} AND kind = 'COMMON'`;
      idMap.set(`pc-${e.id}`, common.id);
    }
    const virtuals = await tx`SELECT id::text, virtual_kind FROM account WHERE kind = 'VIRTUAL'`;
    for (const a of seed.accounts) {
      if (a.kind === 'VIRTUAL') {
        idMap.set(a.id, virtuals.find((v) => v.virtual_kind === a.virtualKind)!.id);
        continue;
      }
      idMap.set(a.id, await createAccount(tx, { ...a, kind: a.kind, entityId: a.entityId ? idMap.get(a.entityId) : undefined }, actor));
    }
    for (const p of seed.projects.filter((x) => x.kind === 'NORMAL')) {
      idMap.set(p.id, await createProject(tx, { ...p, entityId: idMap.get(p.entityId)! }, actor));
    }
    const flows = seed.flows.map((f) => ({ ...f, tempId: f.id }));
    await createFlows(tx, flows, actor, { idMap, auditAction: 'demo.flows' });
    for (const i of seed.invoices) {
      await saveInvoice(tx, undefined, { ...i, entityId: idMap.get(i.entityId)!, projectId: i.projectId ? idMap.get(i.projectId) : undefined }, actor);
    }
    for (const u of [
      { username: 'caiwu', displayName: '财务（演示）', role: 'FINANCE' },
      { username: 'boss', displayName: '老板（只读）', role: 'READONLY' },
    ]) {
      await tx`INSERT INTO app_user (username, display_name, role, password_hash) VALUES (${u.username}, ${u.displayName}, ${u.role}, ${await hashPassword('demo1234')}) ON CONFLICT DO NOTHING`;
    }
    log(`demo data: ${seed.entities.length} entities, ${seed.accounts.length} accounts, ${seed.projects.length} projects, ${flows.length} flows, ${seed.invoices.length} invoices`);
  });
  invalidate();
}
