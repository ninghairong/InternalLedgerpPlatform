// 全量读取账务数据并转换为共享模型（金额 → 分，id → 字符串）。
// 5 人自用、数据量有限：读取走内存缓存。本进程写入后立即失效；
// 另外每次读取先比对审计日志的最大编号（所有写操作都记审计），其他进程或脚本改了数据库也能感知。
import { centsFromDecimal as c } from '@ledger/shared/format';
import type { Account, Category, Entity, Flow, ImportBatch, Invoice, PayrollBatch, Period, Project, Snapshot, TaxRule, Writeoff } from '@ledger/shared/types';
import type { Db } from './db';

let version = 1;
let cache: Snapshot | undefined;
let cacheAuditMark = '';

export function invalidate() {
  version += 1;
  cache = undefined;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : undefined);
const opt = <T>(v: T | null | undefined) => (v === null ? undefined : v);
const rate = (v: string | null) => (v === null ? undefined : Number(v));

export async function loadSnapshot(db: Db, opts: { fresh?: boolean } = {}): Promise<Snapshot> {
  const [{ mark }] = await db`SELECT COALESCE(max(id), 0)::text || '@' || COALESCE(max(at)::text, '') AS mark FROM audit_log`;
  if (cache && !opts.fresh && mark === cacheAuditMark) return cache;
  const v = version;
  const [entities, profiles, accounts, projects, budgets, categories, flows, splits, allocs, attachCounts, invoices, batches, rules, periods, writeoffs, payBatches, payItems] = await Promise.all([
    db`SELECT * FROM entity ORDER BY code`,
    db`SELECT * FROM entity_tax_profile ORDER BY entity_id, valid_from`,
    db`SELECT * FROM account ORDER BY kind, code`,
    db`SELECT * FROM project ORDER BY code`,
    db`SELECT * FROM project_budget`,
    db`SELECT * FROM category ORDER BY sort, id`,
    db`SELECT f.*, u.display_name AS creator, b.batch_no FROM flow f LEFT JOIN app_user u ON u.id = f.created_by LEFT JOIN import_batch b ON b.id = f.import_batch_id ORDER BY f.biz_date, f.id`,
    db`SELECT * FROM flow_split ORDER BY flow_id, line_no`,
    db`SELECT a.out_flow_id, a.amount, a.is_auto, l.source_flow_id FROM flow_allocation a JOIN fund_lot l ON l.id = a.lot_id WHERE a.released_at IS NULL ORDER BY a.id`,
    db`SELECT target_id, count(*)::int AS n FROM attachment_link WHERE target_type = 'FLOW' GROUP BY 1`,
    db`SELECT * FROM invoice ORDER BY issue_date, id`,
    db`SELECT b.*, u.display_name AS creator FROM import_batch b JOIN app_user u ON u.id = b.created_by WHERE b.status <> 'VALIDATED' ORDER BY b.id DESC LIMIT 200`,
    db`SELECT * FROM tax_rule ORDER BY tax, valid_from`,
    db`SELECT p.*, u.display_name AS closer FROM accounting_period p LEFT JOIN app_user u ON u.id = p.closed_by ORDER BY entity_id, period`,
    db`SELECT w.*, l.source_flow_id, u.display_name AS creator FROM lot_writeoff w JOIN fund_lot l ON l.id = w.lot_id LEFT JOIN app_user u ON u.id = w.created_by ORDER BY w.id`,
    db`SELECT p.*, b.batch_no, b.status AS import_status FROM payroll_batch p LEFT JOIN import_batch b ON b.id = p.import_batch_id ORDER BY p.period DESC, p.id DESC`,
    db`SELECT * FROM payroll_item ORDER BY batch_id, id`,
  ]);

  const profByEntity = new Map<string, Entity['taxProfiles']>();
  for (const p of profiles) {
    const list = profByEntity.get(String(p.entity_id)) ?? [];
    list.push({ taxpayerType: p.taxpayer_type, vatFiling: p.vat_filing, validFrom: p.valid_from, validTo: opt(p.valid_to), urbanRate: Number(p.urban_rate), halving: p.halving });
    profByEntity.set(String(p.entity_id), list);
  }
  const budgetBy = new Map<string, Record<string, number>>();
  for (const b of budgets) {
    const m = budgetBy.get(String(b.project_id)) ?? {};
    m[b.category_id] = c(b.amount);
    budgetBy.set(String(b.project_id), m);
  }
  const splitsBy = new Map<string, Flow['splits']>();
  for (const s of splits) {
    const list = splitsBy.get(String(s.flow_id)) ?? [];
    list.push({ projectId: String(s.project_id), categoryId: s.category_id, amount: c(s.amount), tax: opt(s.tax), taxPeriod: opt(s.tax_period) });
    splitsBy.set(String(s.flow_id), list);
  }
  const allocBy = new Map<string, Flow['allocations']>();
  for (const a of allocs) {
    const list = allocBy.get(String(a.out_flow_id)) ?? [];
    list.push({ lotFlowId: String(a.source_flow_id), amount: c(a.amount), auto: a.is_auto });
    allocBy.set(String(a.out_flow_id), list);
  }
  const attach = new Map(attachCounts.map((r) => [String(r.target_id), r.n as number]));
  const itemsBy = new Map<string, PayrollBatch['items']>();
  for (const i of payItems) {
    const list = itemsBy.get(String(i.batch_id)) ?? [];
    list.push({
      person: i.person, idLast4: opt(i.id_last4), gross: c(i.gross), siPersonal: c(i.si_personal), hfPersonal: c(i.hf_personal), iit: c(i.iit), otherDeduct: c(i.other_deduct),
      net: c(i.net), siCompany: c(i.si_company), hfCompany: c(i.hf_company), payeeAccountId: String(i.payee_account_id), netFlowId: i.net_flow_id ? String(i.net_flow_id) : undefined,
    });
    itemsBy.set(String(i.batch_id), list);
  }

  const snap: Snapshot = {
    version: v,
    entities: entities.map((e): Entity => {
      const taxProfiles = profByEntity.get(String(e.id)) ?? [];
      const cur = taxProfiles[taxProfiles.length - 1];
      return {
        id: String(e.id), code: e.code, name: e.name, shortName: e.short_name, kind: e.kind, parentId: e.parent_id ? String(e.parent_id) : undefined,
        region: e.region, uscc: opt(e.uscc), status: e.status, taxProfiles, taxpayerType: cur?.taxpayerType ?? 'GENERAL', vatFiling: cur?.vatFiling ?? 'MONTH',
      };
    }),
    accounts: accounts.map((a): Account => ({
      id: String(a.id), code: a.code, name: a.name, kind: a.kind, virtualKind: opt(a.virtual_kind), entityId: a.entity_id ? String(a.entity_id) : undefined,
      holder: opt(a.holder), bank: opt(a.bank), last4: opt(a.last4), trace: a.trace, status: a.status, remark: opt(a.remark),
    })),
    projects: projects.map((p): Project => ({
      id: String(p.id), code: p.code, name: p.name, entityId: String(p.entity_id), kind: p.kind, manager: p.manager, customer: opt(p.customer), region: opt(p.region),
      vatMethod: p.vat_method, contractAmount: c(p.contract_amount), budget: budgetBy.get(String(p.id)) ?? {}, status: p.status, startDate: opt(p.start_date),
    })),
    categories: categories.map((x): Category => ({ id: x.id, parentId: opt(x.parent_id), name: x.name, nature: x.nature, affectsPnl: x.affects_pnl, requiresTax: x.requires_tax })),
    flows: flows.map((f): Flow => ({
      id: String(f.id), flowNo: f.flow_no, date: f.biz_date, amount: c(f.amount), fromAccountId: String(f.from_account_id), toAccountId: String(f.to_account_id), method: f.method,
      bookSummary: opt(f.book_summary), actualPurpose: opt(f.actual_purpose), purposeMismatch: f.purpose_mismatch, icNature: opt(f.ic_nature), handler: opt(f.handler),
      bankSerialNo: opt(f.bank_serial_no), invoiceNos: f.invoice_nos?.length ? f.invoice_nos : undefined, status: f.status, importBatchNo: opt(f.batch_no), remark: opt(f.remark),
      reversalReason: opt(f.reversal_reason), createdBy: opt(f.creator), createdAt: iso(f.created_at)!,
      splits: splitsBy.get(String(f.id)) ?? [], allocations: allocBy.get(String(f.id)) ?? [], attachmentCount: attach.get(String(f.id)) ?? 0,
    })),
    invoices: invoices.map((i): Invoice => ({
      id: String(i.id), direction: i.direction, type: i.type, invoiceNo: i.invoice_no, issueDate: i.issue_date, entityId: String(i.entity_id), projectId: i.project_id ? String(i.project_id) : undefined,
      counterparty: i.counterparty, amountExclTax: c(i.amount_excl_tax), taxRate: Number(i.tax_rate), taxAmount: c(i.tax_amount), goods: i.goods, remark: opt(i.remark),
    })),
    importBatches: batches.map((b): ImportBatch => ({
      id: String(b.id), batchNo: b.batch_no, template: b.templates, fileName: b.file_names, createdAt: iso(b.created_at)!, createdBy: b.creator,
      total: b.total_rows, committed: b.committed_rows, status: b.status,
    })),
    taxRules: rules.map((r): TaxRule => ({
      id: String(r.id), tax: r.tax, name: r.name, taxpayer: opt(r.taxpayer), method: opt(r.method), rate: Number(r.rate), thresholdAmount: r.threshold_amount === null ? undefined : c(r.threshold_amount),
      thresholdPeriod: opt(r.threshold_period), reductionRatio: rate(r.reduction_ratio), validFrom: r.valid_from, validTo: opt(r.valid_to), policyRef: opt(r.policy_ref),
    })),
    periods: periods.map((p): Period => ({ entityId: String(p.entity_id), period: String(p.period).slice(0, 7), status: p.status, closedBy: opt(p.closer), closedAt: iso(p.closed_at) })),
    writeoffs: writeoffs.map((w): Writeoff => ({ id: String(w.id), lotFlowId: String(w.source_flow_id), amount: c(w.amount), categoryId: w.category_id, reason: w.reason, createdBy: w.creator ?? '', createdAt: iso(w.created_at)! })),
    payrolls: payBatches.map((p): PayrollBatch => ({
      id: String(p.id), entityId: String(p.entity_id), month: String(p.period).slice(0, 7), seq: p.seq, payAccountId: String(p.pay_account_id), payDate: p.pay_date,
      importBatchNo: opt(p.batch_no), voided: p.import_status === 'ROLLED_BACK', items: itemsBy.get(String(p.id)) ?? [],
    })),
  };
  if (!opts.fresh && v === version) {
    cache = snap;
    cacheAuditMark = mark;
  }
  return snap;
}

export const closedPeriodKeys = (snap: Snapshot) => new Set(snap.periods.filter((p) => p.status === 'CLOSED').map((p) => `${p.entityId}|${p.period}`));
