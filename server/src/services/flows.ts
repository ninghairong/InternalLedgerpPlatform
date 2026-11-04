// 资金流水的写入：新建（含自动分配来源）、冲销、外部差额核销。
// 应用层先做完整校验给出可读的错误；数据库触发器再兜底（分摊合计、溯源合计、超额分配、期间锁、不可修改）。
import { decimalFromCents as d } from '@ledger/shared/format';
import type { NewFlowInput } from '@ledger/shared/importer';
import type { Account, Category, ID, Project } from '@ledger/shared/types';
import type { Tx } from '../db';
import { audit, type Actor } from '../audit';
import { badRequest, notFound } from '../errors';
import { money } from '@ledger/shared/format';

export interface CreateFlowsOptions {
  importBatchId?: string;
  /** 已知的 tempId → 正式 id（导入时新建的账户、项目） */
  idMap?: Map<string, string>;
  auditAction?: string;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

async function loadRefs(tx: Tx) {
  const [accounts, projects, categories] = await Promise.all([
    tx`SELECT id, name, kind, entity_id, trace, status FROM account`,
    tx`SELECT id, name, entity_id, status, kind FROM project`,
    tx`SELECT id, name, parent_id, requires_tax FROM category`,
  ]);
  return {
    acc: new Map(accounts.map((a) => [String(a.id), { id: String(a.id), name: a.name, kind: a.kind, entityId: a.entity_id ? String(a.entity_id) : undefined, trace: a.trace, status: a.status } as Account])),
    proj: new Map(projects.map((p) => [String(p.id), { id: String(p.id), name: p.name, entityId: String(p.entity_id), status: p.status, kind: p.kind } as Project])),
    cat: new Map(categories.map((x) => [x.id as string, { id: x.id, name: x.name, parentId: x.parent_id ?? undefined, requiresTax: x.requires_tax } as Category])),
  };
}

async function nextFlowNo(tx: Tx, date: string) {
  const [{ n }] = await tx`SELECT nextval('flow_no_seq') AS n`;
  return `F${date.slice(0, 4)}${date.slice(5, 7)}-${String(n).padStart(6, '0')}`;
}

/**
 * 按输入顺序写入多笔流水（同一事务）。后面的流水可以通过 tempId 引用前面流水作为资金来源。
 * 出款账户强制溯源且未给出来源时，按"同项目优先、先进先出"在数据库中加锁自动分配。
 */
export async function createFlows(tx: Tx, inputs: NewFlowInput[], actor: Actor, opts: CreateFlowsOptions = {}) {
  if (!inputs.length) throw badRequest('没有要保存的流水');
  const refs = await loadRefs(tx);
  const idMap = new Map(opts.idMap ?? []);
  const resolve = (id: string) => idMap.get(id) ?? id;
  const created: { id: string; flowNo: string; tempId?: string }[] = [];

  for (const [i, raw] of inputs.entries()) {
    const label = inputs.length > 1 ? `第 ${i + 1} 笔：` : '';
    const fail = (m: string) => badRequest(`${label}${m}`);
    const f = { ...raw, fromAccountId: resolve(raw.fromAccountId), toAccountId: resolve(raw.toAccountId), splits: raw.splits.map((s) => ({ ...s, projectId: resolve(s.projectId) })) };

    if (!isDate(f.date)) throw fail(`日期「${f.date}」无效`);
    if (!Number.isSafeInteger(f.amount) || f.amount <= 0) throw fail('金额必须为正数');
    const from = refs.acc.get(f.fromAccountId);
    const to = refs.acc.get(f.toAccountId);
    if (!from || !to) throw fail('转出或转入账户不存在');
    if (from.status !== 'ACTIVE' || to.status !== 'ACTIVE') throw fail(`账户「${from.status !== 'ACTIVE' ? from.name : to.name}」已停用`);
    if (from.id === to.id) throw fail('转出与转入账户不能相同');
    if (!f.splits.length) throw fail('至少需要一行项目分摊');
    const splitSum = f.splits.reduce((s, x) => s + x.amount, 0);
    if (splitSum !== f.amount) throw fail(`分摊合计 ${money(splitSum)} 与金额 ${money(f.amount)} 不一致`);
    for (const s of f.splits) {
      const p = refs.proj.get(s.projectId);
      if (!p) throw fail('分摊项目不存在');
      if (p.status === 'CLOSED') throw fail(`项目「${p.name}」已结项，不能再记账`);
      const c = refs.cat.get(s.categoryId);
      if (!c || !c.parentId) throw fail('账目类型须选到二级');
      if (!Number.isSafeInteger(s.amount) || s.amount <= 0) throw fail('分摊金额必须为正数');
      if (c.requiresTax && (!s.tax || !s.taxPeriod)) throw fail(`「${c.name}」须填写税种和所属期`);
      if (!c.requiresTax && s.tax) throw fail(`「${c.name}」不是税费类型，不能填写税种`);
    }
    const isIc = !!(from.entityId && to.entityId && from.entityId !== to.entityId);
    if (isIc && !f.icNature) throw fail(`${from.name} → ${to.name} 是集团内往来，须选择往来性质`);
    const icNature = isIc ? f.icNature : null;

    const flowNo = await nextFlowNo(tx, f.date);
    const [row] = await tx`
      INSERT INTO flow (flow_no, biz_date, amount, from_account_id, to_account_id, method, book_summary, actual_purpose, purpose_mismatch,
                        ic_nature, handler, bank_serial_no, invoice_nos, import_batch_id, remark, created_by)
      VALUES (${flowNo}, ${f.date}, ${d(f.amount)}, ${f.fromAccountId}, ${f.toAccountId}, ${f.method}, ${f.bookSummary ?? null}, ${f.actualPurpose ?? null},
              ${!!f.purposeMismatch}, ${icNature ?? null}, ${f.handler ?? null}, ${f.bankSerialNo ?? null}, ${f.invoiceNos ?? []}, ${opts.importBatchId ?? null},
              ${f.remark ?? null}, ${actor.id})
      RETURNING id`;
    const id = String(row.id);
    for (const [n, s] of f.splits.entries()) {
      await tx`INSERT INTO flow_split (flow_id, line_no, project_id, category_id, amount, tax, tax_period)
               VALUES (${id}, ${n + 1}, ${s.projectId}, ${s.categoryId}, ${d(s.amount)}, ${s.tax ?? null}, ${s.taxPeriod ?? null})`;
    }

    // ---- 资金来源
    let allocations = f.allocations.map((a) => ({ ...a, lotFlowId: resolve(a.lotFlowId) }));
    if (from.trace === 'REQUIRED' && !allocations.length) allocations = await autoAllocateDb(tx, from, f.amount, f.date, f.splits[0].projectId, fail);
    if (from.trace === 'NONE' && allocations.length) throw fail(`「${from.name}」不需要资金来源`);
    if (allocations.length) {
      const total = allocations.reduce((s, a) => s + a.amount, 0);
      if (total !== f.amount) throw fail(`资金来源合计 ${money(total)} 与金额 ${money(f.amount)} 不一致`);
      for (const a of allocations) {
        if (!Number.isSafeInteger(a.amount) || a.amount <= 0) throw fail('资金来源金额必须为正数');
        const [lot] = await tx`SELECT l.id, l.account_id, l.remaining_amount, f.flow_no FROM fund_lot l JOIN flow f ON f.id = l.source_flow_id WHERE l.source_flow_id = ${a.lotFlowId} FOR UPDATE OF l`;
        if (!lot) throw fail('资金来源不存在');
        if (String(lot.account_id) !== from.id) throw fail(`资金来源 ${lot.flow_no} 不是转入「${from.name}」的款项`);
        await tx`INSERT INTO flow_allocation (out_flow_id, lot_id, amount, is_auto) VALUES (${id}, ${lot.id}, ${d(a.amount)}, ${a.auto})`;
      }
    }
    if (raw.tempId) idMap.set(raw.tempId, id);
    created.push({ id, flowNo, tempId: raw.tempId });
  }

  await audit(tx, actor, opts.auditAction ?? 'flow.create', 'FLOW', created.length === 1 ? created[0].id : null, `新建流水 ${created.map((c) => c.flowNo).join('、')}`, { count: created.length, importBatchId: opts.importBatchId });
  return { created, idMap };
}

/** 同项目的入款优先，再按入款日期先进先出；对候选资金批次加行锁，防止并发超分配 */
async function autoAllocateDb(tx: Tx, from: Account, amount: number, date: string, projectId: ID, fail: (m: string) => Error) {
  const lots = await tx`
    SELECT l.id, l.source_flow_id, l.remaining_amount,
           EXISTS (SELECT 1 FROM flow_split s WHERE s.flow_id = l.source_flow_id AND s.project_id = ${projectId}) AS same_project
      FROM fund_lot l
     WHERE l.account_id = ${from.id} AND l.remaining_amount > 0 AND l.received_date <= ${date}
     ORDER BY same_project DESC, l.received_date, l.id
       FOR UPDATE OF l`;
  const out: { lotFlowId: string; amount: number; auto: boolean }[] = [];
  let need = amount;
  for (const l of lots) {
    if (need <= 0) break;
    const left = Math.round(Number(l.remaining_amount) * 100);
    const take = Math.min(left, need);
    out.push({ lotFlowId: String(l.source_flow_id), amount: take, auto: true });
    need -= take;
  }
  if (need > 0) throw fail(`「${from.name}」截至 ${date} 可用资金 ${money(amount - need)}，不足 ${money(amount)}。每笔出款都必须有资金来源，请先录入这笔钱的来源`);
  return out;
}

/** 冲销（或撤销导入）：下游未处理、所在期间已结账时由数据库拒绝 */
export async function reverseFlow(tx: Tx, id: string, reason: string, actor: Actor, status: 'REVERSED' | 'VOIDED' = 'REVERSED') {
  const [f] = await tx`SELECT id, flow_no, status FROM flow WHERE id = ${id} FOR UPDATE`;
  if (!f) throw notFound('流水');
  if (f.status !== 'CONFIRMED') throw badRequest(`流水 ${f.flow_no} 已冲销或撤销`);
  if (!reason.trim()) throw badRequest('请填写冲销原因');
  await tx`UPDATE flow SET status = ${status}, reversal_reason = ${reason}, reversed_by = ${actor.id}, reversed_at = now() WHERE id = ${id}`;
  await audit(tx, actor, status === 'REVERSED' ? 'flow.reverse' : 'flow.void', 'FLOW', id, `${status === 'REVERSED' ? '冲销' : '撤销'}流水 ${f.flow_no}：${reason}`);
  return f.flow_no as string;
}

/** 外部账户（可选溯源）上的未说明差额核销 */
export async function writeoffLot(tx: Tx, lotFlowId: string, amount: number, categoryId: string, reason: string, actor: Actor) {
  const [lot] = await tx`SELECT l.id, l.remaining_amount, f.flow_no, a.trace, a.name FROM fund_lot l JOIN flow f ON f.id = l.source_flow_id JOIN account a ON a.id = l.account_id WHERE l.source_flow_id = ${lotFlowId} FOR UPDATE OF l`;
  if (!lot) throw notFound('资金批次');
  if (lot.trace === 'REQUIRED') throw badRequest(`「${lot.name}」中的余额不能直接核销，请录入一笔转出流水（如转入"损失核销"）`);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw badRequest('核销金额必须为正数');
  const left = Math.round(Number(lot.remaining_amount) * 100);
  if (amount > left) throw badRequest(`该笔剩余 ${money(left)}，核销金额不能超过剩余`);
  if (!reason.trim()) throw badRequest('请说明差额原因');
  const [cat] = await tx`SELECT id, parent_id FROM category WHERE id = ${categoryId}`;
  if (!cat?.parent_id) throw badRequest('请选择差额对应的账目类型（二级）');
  await tx`INSERT INTO lot_writeoff (lot_id, amount, category_id, reason, created_by) VALUES (${lot.id}, ${d(amount)}, ${categoryId}, ${reason}, ${actor.id})`;
  await audit(tx, actor, 'lot.writeoff', 'FLOW', lotFlowId, `核销 ${lot.flow_no} 差额 ${money(amount)}：${reason}`);
}

/** 只允许修改不影响账务的字段 */
export async function updateFlowInfo(tx: Tx, id: string, patch: { remark?: string; actualPurpose?: string; purposeMismatch?: boolean; invoiceNos?: string[]; handler?: string }, actor: Actor) {
  const [f] = await tx`SELECT * FROM flow WHERE id = ${id} FOR UPDATE`;
  if (!f) throw notFound('流水');
  await tx`UPDATE flow SET remark = ${patch.remark ?? f.remark}, actual_purpose = ${patch.actualPurpose ?? f.actual_purpose},
             purpose_mismatch = ${patch.purposeMismatch ?? f.purpose_mismatch}, invoice_nos = ${patch.invoiceNos ?? f.invoice_nos}, handler = ${patch.handler ?? f.handler}
           WHERE id = ${id}`;
  await audit(tx, actor, 'flow.update', 'FLOW', id, `修改流水 ${f.flow_no} 的说明信息`, { before: { remark: f.remark, actualPurpose: f.actual_purpose, purposeMismatch: f.purpose_mismatch, invoiceNos: f.invoice_nos, handler: f.handler }, after: patch });
}
