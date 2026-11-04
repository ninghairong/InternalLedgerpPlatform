// Excel 导入：上传 → 校验（共享校验逻辑）→ 跳过部分行后重新校验 → 提交（事务内对最新数据重新校验后写入）→ 整批撤销。
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseWorkbook, TEMPLATE_NAMES } from '@ledger/shared/excel';
import { postingOrder, serializeFiles, validate, type ImportFile, type ImportRow } from '@ledger/shared/importer';
import { today } from '@ledger/shared/format';
import { decimalFromCents as d } from '@ledger/shared/format';
import type { Snapshot } from '@ledger/shared/types';
import { config } from '../config';
import type { Sql, Tx } from '../db';
import { audit, type Actor } from '../audit';
import { AppError, badRequest, notFound } from '../errors';
import { closedPeriodKeys, invalidate, loadSnapshot } from '../snapshot';
import { createFlows, reverseFlow } from './flows';
import { addTaxProfile, createAccount, createEntity, createProject, updateAccount, updateEntity, updateProject } from './master';

export interface UploadedFile {
  name: string;
  data: Buffer;
  mime: string;
}

const summarize = (rows: ImportRow[]) => ({
  total: rows.length,
  ok: rows.filter((r) => r.status === 'OK').length,
  warning: rows.filter((r) => r.status === 'WARNING').length,
  error: rows.filter((r) => r.status === 'ERROR').length,
  duplicate: rows.filter((r) => r.status === 'DUPLICATE').length,
  matched: rows.filter((r) => r.status === 'MATCHED').length,
  skipped: rows.filter((r) => r.status === 'SKIPPED').length,
});

const committable = (r: ImportRow) => r.status === 'OK' || r.status === 'WARNING';

function runValidate(files: ImportFile[], snap: Snapshot, skip: string[]) {
  return validate(files, snap, { skip: new Set(skip), closedPeriods: closedPeriodKeys(snap), today: today() });
}

async function saveAttachment(tx: Tx, f: UploadedFile, actor: Actor) {
  const sha = createHash('sha256').update(f.data).digest('hex');
  const key = path.join(today().slice(0, 7), `${randomUUID()}${path.extname(f.name) || '.bin'}`);
  await fs.mkdir(path.join(config.attachmentDir, path.dirname(key)), { recursive: true });
  await fs.writeFile(path.join(config.attachmentDir, key), f.data);
  const [row] = await tx`INSERT INTO attachment (storage_key, file_name, mime_type, size_bytes, sha256, uploaded_by) VALUES (${key}, ${f.name}, ${f.mime}, ${f.data.length}, ${sha}, ${actor.id}) RETURNING id`;
  return String(row.id);
}

export async function uploadImport(sql: Sql, files: UploadedFile[], actor: Actor) {
  if (!files.length) throw badRequest('请选择要导入的文件');
  const parsed: ImportFile[] = [];
  for (const f of files) {
    if (!/\.xlsx$/i.test(f.name)) throw badRequest(`「${f.name}」不是 .xlsx 文件`);
    try {
      parsed.push({ name: f.name, sheets: await parseWorkbook(f.data) });
    } catch (e) {
      throw badRequest(`「${f.name}」：${(e as Error).message}`);
    }
  }
  const stored = serializeFiles(parsed);
  const snap = await loadSnapshot(sql);
  const rows = runValidate(stored, snap, []);
  const templates = [...new Set(stored.flatMap((f) => f.sheets.map((s) => TEMPLATE_NAMES[s.template])))].join('+');
  return sql.begin(async (tx) => {
    const [{ n }] = await tx`SELECT count(*)::int + 1 AS n FROM import_batch WHERE created_at::date = current_date`;
    const batchNo = `IMP-${today().replace(/-/g, '')}-${String(n).padStart(4, '0')}`;
    const [b] = await tx`
      INSERT INTO import_batch (batch_no, templates, file_names, parsed, result, total_rows, created_by)
      VALUES (${batchNo}, ${templates}, ${files.map((f) => f.name).join('、')}, ${stored as never}, ${rows as never}, ${rows.length}, ${actor.id})
      RETURNING id`;
    for (const f of files) {
      const att = await saveAttachment(tx, f, actor);
      await tx`INSERT INTO attachment_link (attachment_id, target_type, target_id) VALUES (${att}, 'IMPORT', ${b.id})`;
    }
    await audit(tx, actor, 'import.upload', 'IMPORT', String(b.id), `上传导入文件 ${files.map((f) => f.name).join('、')}（${rows.length} 行）`, summarize(rows));
    return { id: String(b.id), batchNo, rows, summary: summarize(rows) };
  });
}

async function loadBatch(db: Sql | Tx, id: string, lock = false) {
  const [b] = lock ? await db`SELECT * FROM import_batch WHERE id = ${id} FOR UPDATE` : await db`SELECT * FROM import_batch WHERE id = ${id}`;
  if (!b) throw notFound('导入批次');
  return b;
}

export async function getImport(sql: Sql, id: string) {
  const b = await loadBatch(sql, id);
  return { id: String(b.id), batchNo: b.batch_no, status: b.status, rows: (b.result ?? []) as ImportRow[], skip: b.skip_keys as string[], summary: summarize((b.result ?? []) as ImportRow[]) };
}

export async function revalidateImport(sql: Sql, id: string, skip: string[]) {
  const b = await loadBatch(sql, id);
  if (b.status !== 'VALIDATED') throw badRequest('该批次已提交或已撤销');
  const rows = runValidate(b.parsed as ImportFile[], await loadSnapshot(sql), skip);
  await sql`UPDATE import_batch SET skip_keys = ${skip as never}, result = ${rows as never} WHERE id = ${id}`;
  return { id, batchNo: b.batch_no, status: b.status, rows, skip, summary: summarize(rows) };
}

/** 提交：在事务内锁定批次，按最新数据重新校验，只写入通过（含警告）的行 */
export async function commitImport(sql: Sql, id: string, actor: Actor) {
  const result = await sql.begin(async (tx) => {
    const b = await loadBatch(tx, id, true);
    if (b.status !== 'VALIDATED') throw badRequest('该批次已提交或已撤销');
    const snap = await loadSnapshot(tx, { fresh: true });
    const rows = runValidate(b.parsed as ImportFile[], snap, b.skip_keys as string[]);
    const ok = rows.filter(committable);
    if (!ok.length) throw badRequest('没有可导入的行');
    const idMap = new Map<string, string>();
    const map = (v?: string) => (v ? (idMap.get(v) ?? v) : v);

    // 1) 主数据：主体 → 账户 → 项目（与校验顺序一致）
    for (const r of ok.filter((x) => x.master?.type === 'ENTITY')) {
      const m = r.master!;
      if (m.type !== 'ENTITY') continue;
      const e = { ...m.data, parentId: map(m.data.parentId) };
      if (m.op === 'CREATE') {
        const newId = await createEntity(tx, e, e.taxProfiles[0], actor);
        idMap.set(m.id, newId);
        const [common] = await tx`SELECT id::text FROM project WHERE entity_id = ${newId} AND kind = 'COMMON'`;
        if (m.commonProjectId) idMap.set(m.commonProjectId, common.id);
      } else {
        await updateEntity(tx, m.id, e, actor);
        if (m.newProfile) await addTaxProfile(tx, m.id, m.newProfile, actor);
      }
    }
    for (const r of ok.filter((x) => x.master?.type === 'ACCOUNT')) {
      const m = r.master!;
      if (m.type !== 'ACCOUNT') continue;
      if (m.op === 'CREATE') idMap.set(m.id, await createAccount(tx, { ...m.data, entityId: map(m.data.entityId) }, actor));
      else await updateAccount(tx, m.id, m.data, actor);
    }
    let autoSeq = 0;
    for (const r of ok) {
      const a = r.newAccount;
      if (!a || idMap.has(a.id)) continue;
      idMap.set(a.id, await createAccount(tx, { code: `X-${b.batch_no.slice(4)}-${String(++autoSeq).padStart(3, '0')}`, name: a.name, kind: 'EXTERNAL', remark: `导入批次 ${b.batch_no} 自动创建` }, actor));
    }
    for (const r of ok.filter((x) => x.master?.type === 'PROJECT')) {
      const m = r.master!;
      if (m.type !== 'PROJECT') continue;
      if (m.op === 'CREATE') idMap.set(m.id, await createProject(tx, { ...m.data, entityId: map(m.data.entityId)! }, actor));
      else await updateProject(tx, m.id, m.data, actor);
    }

    // 2) 流水：与校验相同的入账顺序，资金来源中的 tempId 由 createFlows 逐笔替换
    const flowRows = postingOrder(ok);
    let flowIdMap = idMap;
    if (flowRows.length) {
      const res = await createFlows(tx, flowRows.map((r) => r.flow!), actor, { importBatchId: id, idMap, auditAction: 'import.flows' });
      flowIdMap = res.idMap;
    }

    // 3) 工资批次
    const byBatch = new Map<string, ImportRow[]>();
    for (const r of ok) if (r.payroll) byBatch.set(r.payroll.batchKey, [...(byBatch.get(r.payroll.batchKey) ?? []), r]);
    for (const list of byBatch.values()) {
      const p0 = list[0].payroll!;
      const [{ seq }] = await tx`SELECT COALESCE(max(seq), 0) + 1 AS seq FROM payroll_batch WHERE entity_id = ${p0.entityId} AND period = ${`${p0.month}-01`}`;
      const [pb] = await tx`INSERT INTO payroll_batch (entity_id, period, seq, pay_account_id, pay_date, import_batch_id, created_by)
                            VALUES (${p0.entityId}, ${`${p0.month}-01`}, ${seq}, ${p0.payAccountId}, ${p0.payDate}, ${id}, ${actor.id}) RETURNING id`;
      for (const r of list) {
        const p = r.payroll!;
        await tx`INSERT INTO payroll_item (batch_id, person, id_last4, gross, si_personal, hf_personal, iit, other_deduct, net, si_company, hf_company, payee_account_id, net_flow_id)
                 VALUES (${pb.id}, ${p.person}, ${p.idLast4 ?? null}, ${d(p.gross)}, ${d(p.siPersonal)}, ${d(p.hfPersonal)}, ${d(p.iit)}, ${d(p.otherDeduct)}, ${d(p.net)},
                         ${d(p.siCompany)}, ${d(p.hfCompany)}, ${flowIdMap.get(p.payeeAccountId) ?? p.payeeAccountId}, ${r.flow ? (flowIdMap.get(r.flow.tempId) ?? null) : null})`;
      }
    }

    await tx`UPDATE import_batch SET status = 'COMMITTED', result = ${rows as never}, committed_rows = ${ok.length}, committed_at = now() WHERE id = ${id}`;
    await audit(tx, actor, 'import.commit', 'IMPORT', id, `提交导入批次 ${b.batch_no}：${ok.length} 行`, summarize(rows));
    return { id, batchNo: b.batch_no as string, committed: ok.length, flows: flowRows.length, summary: summarize(rows), rows };
  });
  invalidate();
  return result;
}

/** 整批撤销：按入账的倒序逐笔撤销（下游先撤）；被批次外流水引用时由数据库拒绝。主数据（主体、账户、项目）保留 */
export async function rollbackImport(sql: Sql, id: string, actor: Actor) {
  const res = await sql.begin(async (tx) => {
    const b = await loadBatch(tx, id, true);
    if (b.status !== 'COMMITTED') throw badRequest('只有已提交的批次可以撤销');
    const flows = await tx`SELECT id FROM flow WHERE import_batch_id = ${id} AND status = 'CONFIRMED' ORDER BY biz_date DESC, id DESC`;
    try {
      for (const f of flows) await reverseFlow(tx, String(f.id), `撤销导入批次 ${b.batch_no}`, actor, 'VOIDED');
    } catch (e) {
      if (e instanceof AppError) throw e;
      const msg = (e as Error).message ?? '';
      throw badRequest(msg.replace(/^HAS_DOWNSTREAM: /, ''));
    }
    await tx`UPDATE import_batch SET status = 'ROLLED_BACK', rolled_back_at = now(), rolled_back_by = ${actor.id} WHERE id = ${id}`;
    await audit(tx, actor, 'import.rollback', 'IMPORT', id, `撤销导入批次 ${b.batch_no}（${flows.length} 笔流水）`);
    return { voided: flows.length };
  });
  invalidate();
  return res;
}
