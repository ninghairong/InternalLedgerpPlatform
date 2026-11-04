// 主数据：主体、账户、项目、发票、会计期间、用户。导入（主体/账户/项目模板）与页面操作共用这些函数。
import { decimalFromCents as d, money, today } from '@ledger/shared/format';
import { computeTraces } from '@ledger/shared/selectors';
import type { Account, Entity, Invoice, Project, Role, TaxProfile } from '@ledger/shared/types';
import type { Tx } from '../db';
import { audit, type Actor } from '../audit';
import { badRequest, notFound } from '../errors';
import { hashPassword } from '../password';
import { loadSnapshot } from '../snapshot';
import { createFlows } from './flows';

// ---------------------------------------------------------------- 主体

export async function createEntity(tx: Tx, e: Omit<Entity, 'id' | 'taxProfiles' | 'status' | 'taxpayerType' | 'vatFiling'>, profile: TaxProfile, actor: Actor) {
  if (e.kind === 'BRANCH' && !e.parentId) throw badRequest('分公司须选择上级公司');
  const [row] = await tx`
    INSERT INTO entity (code, name, short_name, uscc, kind, parent_id, region)
    VALUES (${e.code}, ${e.name}, ${e.shortName}, ${e.uscc ?? null}, ${e.kind}, ${e.parentId ?? null}, ${e.region}) RETURNING id`;
  const id = String(row.id);
  await addTaxProfile(tx, id, profile, actor, false);
  // 每个主体自动有一个"公司公共"项目，承接管理费用、税费等
  await tx`INSERT INTO project (entity_id, code, name, kind, manager) VALUES (${id}, ${`P-${e.code}-COMMON`}, ${`${e.shortName}·公司公共`}, 'COMMON', '财务')`;
  await audit(tx, actor, 'entity.create', 'ENTITY', id, `新增主体 ${e.name}（${profile.taxpayerType === 'GENERAL' ? '一般纳税人' : '小规模'}）`);
  return id;
}

export async function updateEntity(tx: Tx, id: string, e: Partial<Pick<Entity, 'name' | 'shortName' | 'uscc' | 'kind' | 'parentId' | 'region' | 'status'>>, actor: Actor) {
  const [cur] = await tx`SELECT * FROM entity WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound('主体');
  const kind = e.kind ?? cur.kind;
  const parentId = e.parentId === undefined ? cur.parent_id : e.parentId || null;
  if (kind === 'BRANCH' && !parentId) throw badRequest('分公司须选择上级公司');
  await tx`UPDATE entity SET name = ${e.name ?? cur.name}, short_name = ${e.shortName ?? cur.short_name}, uscc = ${e.uscc === undefined ? cur.uscc : e.uscc || null},
             kind = ${kind}, parent_id = ${parentId}, region = ${e.region ?? cur.region}, status = ${e.status ?? cur.status} WHERE id = ${id}`;
  await audit(tx, actor, 'entity.update', 'ENTITY', id, `修改主体 ${cur.name}`, { before: cur, after: e });
}

/** 新增一条纳税人身份记录：上一条记录在新生效日截止 */
export async function addTaxProfile(tx: Tx, entityId: string, p: TaxProfile, actor: Actor, log = true) {
  const [last] = await tx`SELECT * FROM entity_tax_profile WHERE entity_id = ${entityId} ORDER BY valid_from DESC LIMIT 1 FOR UPDATE`;
  if (last && p.validFrom <= last.valid_from) throw badRequest(`新的纳税信息生效日期须晚于 ${last.valid_from}`);
  if (last) await tx`UPDATE entity_tax_profile SET valid_to = ${p.validFrom} WHERE id = ${last.id}`;
  await tx`INSERT INTO entity_tax_profile (entity_id, taxpayer_type, vat_filing, valid_from, urban_rate, halving)
           VALUES (${entityId}, ${p.taxpayerType}, ${p.vatFiling}, ${p.validFrom}, ${p.urbanRate}, ${p.halving})`;
  if (log) await audit(tx, actor, 'entity.taxProfile', 'ENTITY', entityId, `纳税信息变更：自 ${p.validFrom} 起为${p.taxpayerType === 'GENERAL' ? '一般纳税人' : '小规模纳税人'}`, p);
}

// ---------------------------------------------------------------- 账户

export interface AccountInput {
  code: string;
  name: string;
  kind: Account['kind'];
  entityId?: string;
  holder?: string;
  bank?: string;
  last4?: string;
  remark?: string;
  opening?: { amount: number; date: string; projectId?: string };
}

export async function createAccount(tx: Tx, a: AccountInput, actor: Actor) {
  if (a.kind === 'VIRTUAL') throw badRequest('虚拟账户由系统预置，不能新增');
  if (a.kind === 'CORPORATE' && !a.entityId) throw badRequest('对公账户须选择所属主体');
  if ((a.kind === 'INTERNAL_PERSONAL' || a.kind === 'CASH') && !a.holder) throw badRequest('个人卡、现金账户须填写持有人');
  const trace = a.kind === 'EXTERNAL' ? 'OPTIONAL' : 'REQUIRED';
  const [row] = await tx`
    INSERT INTO account (code, name, kind, entity_id, holder, bank, last4, trace, remark)
    VALUES (${a.code}, ${a.name}, ${a.kind}, ${a.kind === 'CORPORATE' ? a.entityId! : null}, ${a.holder || null}, ${a.bank || null}, ${a.last4 || null}, ${trace}, ${a.remark || null})
    RETURNING id`;
  const id = String(row.id);
  await audit(tx, actor, 'account.create', 'ACCOUNT', id, `新增账户 ${a.name}`);
  if (a.opening?.amount) {
    // 期初余额 = 一笔"期初 → 账户"的流水，作为之后出款的资金来源
    const [open] = await tx`SELECT id FROM account WHERE virtual_kind = 'OPENING'`;
    let projectId = a.opening.projectId;
    if (!projectId && a.entityId) [{ id: projectId }] = (await tx`SELECT id::text FROM project WHERE entity_id = ${a.entityId} AND kind = 'COMMON'`) as unknown as { id: string }[];
    if (!projectId) throw badRequest('非对公账户有期初余额时须选择期初项目');
    await createFlows(tx, [{ date: a.opening.date || today(), amount: a.opening.amount, fromAccountId: String(open.id), toAccountId: id, method: 'OTHER', bookSummary: '期初余额', splits: [{ projectId, categoryId: 'c-trf-opening', amount: a.opening.amount }], allocations: [] }], actor, { auditAction: 'account.opening' });
  }
  return id;
}

export async function updateAccount(tx: Tx, id: string, a: Partial<Pick<AccountInput, 'name' | 'holder' | 'bank' | 'last4' | 'remark'>> & { status?: 'ACTIVE' | 'DISABLED' }, actor: Actor) {
  const [cur] = await tx`SELECT * FROM account WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound('账户');
  if (cur.kind === 'VIRTUAL' && a.status === 'DISABLED') throw badRequest('系统虚拟账户不能停用');
  if (a.status === 'DISABLED') {
    const [b] = await tx`SELECT balance FROM account_balance WHERE account_id = ${id}`;
    if (cur.kind !== 'EXTERNAL' && b && Number(b.balance) !== 0) throw badRequest(`账户余额为 ${b.balance}，余额清零后才能停用`);
  }
  await tx`UPDATE account SET name = ${a.name ?? cur.name}, holder = ${a.holder === undefined ? cur.holder : a.holder || null}, bank = ${a.bank === undefined ? cur.bank : a.bank || null},
             last4 = ${a.last4 === undefined ? cur.last4 : a.last4 || null}, remark = ${a.remark === undefined ? cur.remark : a.remark || null}, status = ${a.status ?? cur.status}
           WHERE id = ${id}`;
  await audit(tx, actor, 'account.update', 'ACCOUNT', id, `修改账户 ${cur.name}`, { before: cur, after: a });
}

// ---------------------------------------------------------------- 项目

export type ProjectInput = Omit<Project, 'id' | 'kind'> & { kind?: Project['kind'] };

async function writeBudget(tx: Tx, projectId: string, budget: Record<string, number>) {
  await tx`DELETE FROM project_budget WHERE project_id = ${projectId}`;
  for (const [cat, amount] of Object.entries(budget)) if (amount > 0) await tx`INSERT INTO project_budget (project_id, category_id, amount) VALUES (${projectId}, ${cat}, ${d(amount)})`;
}

export async function createProject(tx: Tx, p: ProjectInput, actor: Actor) {
  const [row] = await tx`
    INSERT INTO project (entity_id, code, name, kind, manager, customer, region, vat_method, contract_amount, start_date, status)
    VALUES (${p.entityId}, ${p.code}, ${p.name}, ${p.kind ?? 'NORMAL'}, ${p.manager}, ${p.customer || null}, ${p.region || null}, ${p.vatMethod}, ${d(p.contractAmount || 0)},
            ${p.startDate || null}, ${p.status})
    RETURNING id`;
  const id = String(row.id);
  await writeBudget(tx, id, p.budget ?? {});
  await audit(tx, actor, 'project.create', 'PROJECT', id, `新建项目 ${p.name}`);
  return id;
}

export async function updateProject(tx: Tx, id: string, p: Partial<ProjectInput>, actor: Actor) {
  const [cur] = await tx`SELECT * FROM project WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound('项目');
  if (p.entityId && p.entityId !== String(cur.entity_id)) throw badRequest('项目的承接主体不能修改');
  if (p.status === 'CLOSED' && cur.status !== 'CLOSED') throw badRequest('请使用"结项"操作');
  await tx`UPDATE project SET name = ${p.name ?? cur.name}, manager = ${p.manager ?? cur.manager}, customer = ${p.customer === undefined ? cur.customer : p.customer || null},
             region = ${p.region === undefined ? cur.region : p.region || null}, vat_method = ${p.vatMethod ?? cur.vat_method},
             contract_amount = ${p.contractAmount === undefined ? cur.contract_amount : d(p.contractAmount)}, start_date = ${p.startDate === undefined ? cur.start_date : p.startDate || null},
             status = ${p.status ?? cur.status}, closed_at = ${p.status && p.status !== 'CLOSED' ? null : cur.closed_at}
           WHERE id = ${id}`;
  if (p.budget) await writeBudget(tx, id, p.budget);
  await audit(tx, actor, 'project.update', 'PROJECT', id, `修改项目 ${cur.name}`, { before: cur, after: p });
}

/** 结项前检查：个人/现金账户中没有本项目滞留资金，没有未说明的外部差额 */
export async function projectCloseChecks(tx: Tx, id: string) {
  const snap = await loadSnapshot(tx, { fresh: true });
  const ids = new Set(snap.flows.filter((f) => f.splits.some((s) => s.projectId === id)).map((f) => f.id));
  const traces = computeTraces(snap.flows, snap.accounts, snap.categories, today(), snap.writeoffs).filter((t) => t.edges.some((e) => ids.has(e.flowId)));
  const held = traces.reduce((s, t) => s + t.held, 0);
  const external = traces.reduce((s, t) => s + t.external, 0);
  return [
    { ok: held < 0.5, text: held >= 0.5 ? `相关资金链仍有 ¥${money(Math.round(held))} 滞留在个人/现金账户` : '个人/现金账户中没有相关滞留资金' },
    { ok: external < 0.5, text: external >= 0.5 ? `存在 ¥${money(Math.round(external))} 外部差额未说明` : '没有未说明的外部差额' },
  ];
}

export async function closeProject(tx: Tx, id: string, actor: Actor, force = false) {
  const [cur] = await tx`SELECT * FROM project WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound('项目');
  if (cur.kind === 'COMMON') throw badRequest('"公司公共"项目不能结项');
  if (cur.status === 'CLOSED') throw badRequest('项目已结项');
  const checks = await projectCloseChecks(tx, id);
  if (!force && checks.some((c) => !c.ok)) throw badRequest(`不满足结项条件：${checks.filter((c) => !c.ok).map((c) => c.text).join('；')}`, checks);
  await tx`UPDATE project SET status = 'CLOSED', closed_at = now() WHERE id = ${id}`;
  await audit(tx, actor, 'project.close', 'PROJECT', id, `项目 ${cur.name} 结项${force ? '（管理员强制）' : ''}`);
}

// ---------------------------------------------------------------- 发票

export type InvoiceInput = Omit<Invoice, 'id'>;

export async function saveInvoice(tx: Tx, id: string | undefined, i: InvoiceInput, actor: Actor) {
  if (!(i.taxRate >= 0 && i.taxRate < 1)) throw badRequest('税率无效');
  if (i.amountExclTax < 0 || i.taxAmount < 0) throw badRequest('金额不能为负');
  const expected = Math.round(i.amountExclTax * i.taxRate);
  if (Math.abs(expected - i.taxAmount) > 100) throw badRequest(`税额 ${money(i.taxAmount)} 与 不含税金额 × 税率 = ${money(expected)} 相差超过 1 元`);
  const values = [i.direction, i.type, i.invoiceNo.trim(), i.issueDate, i.entityId, i.projectId || null, i.counterparty, d(i.amountExclTax), i.taxRate, d(i.taxAmount), i.goods, i.remark || null] as const;
  if (id) {
    const [cur] = await tx`SELECT * FROM invoice WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw notFound('发票');
    await tx`UPDATE invoice SET direction = ${values[0]}, type = ${values[1]}, invoice_no = ${values[2]}, issue_date = ${values[3]}, entity_id = ${values[4]}, project_id = ${values[5]},
               counterparty = ${values[6]}, amount_excl_tax = ${values[7]}, tax_rate = ${values[8]}, tax_amount = ${values[9]}, goods = ${values[10]}, remark = ${values[11]} WHERE id = ${id}`;
    await audit(tx, actor, 'invoice.update', 'INVOICE', id, `修改发票 ${i.invoiceNo}`, { before: cur, after: i });
    return id;
  }
  const [row] = await tx`
    INSERT INTO invoice (direction, type, invoice_no, issue_date, entity_id, project_id, counterparty, amount_excl_tax, tax_rate, tax_amount, goods, remark, created_by)
    VALUES (${values[0]}, ${values[1]}, ${values[2]}, ${values[3]}, ${values[4]}, ${values[5]}, ${values[6]}, ${values[7]}, ${values[8]}, ${values[9]}, ${values[10]}, ${values[11]}, ${actor.id})
    RETURNING id`;
  await audit(tx, actor, 'invoice.create', 'INVOICE', String(row.id), `登记${i.direction === 'OUTPUT' ? '销项' : '进项'}发票 ${i.invoiceNo}`);
  return String(row.id);
}

export async function deleteInvoice(tx: Tx, id: string, actor: Actor) {
  const [cur] = await tx`DELETE FROM invoice WHERE id = ${id} RETURNING *`;
  if (!cur) throw notFound('发票');
  await audit(tx, actor, 'invoice.delete', 'INVOICE', id, `删除发票 ${cur.invoice_no}`, cur);
}

// ---------------------------------------------------------------- 会计期间

export async function setPeriod(tx: Tx, entityId: string, period: string, status: 'OPEN' | 'CLOSED', actor: Actor) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw badRequest('期间格式应为 YYYY-MM');
  if (status === 'CLOSED' && period >= today().slice(0, 7)) throw badRequest('只能结账已经结束的月份');
  const [e] = await tx`SELECT short_name FROM entity WHERE id = ${entityId}`;
  if (!e) throw notFound('主体');
  await tx`
    INSERT INTO accounting_period (entity_id, period, status, closed_by, closed_at)
    VALUES (${entityId}, ${`${period}-01`}, ${status}, ${status === 'CLOSED' ? actor.id : null}, ${status === 'CLOSED' ? new Date() : null})
    ON CONFLICT (entity_id, period) DO UPDATE SET status = EXCLUDED.status, closed_by = EXCLUDED.closed_by, closed_at = EXCLUDED.closed_at`;
  await audit(tx, actor, status === 'CLOSED' ? 'period.close' : 'period.reopen', 'ENTITY', entityId, `${e.short_name} ${period} ${status === 'CLOSED' ? '结账' : '反结账'}`);
}

// ---------------------------------------------------------------- 用户

export async function createUser(tx: Tx, u: { username: string; displayName: string; role: Role; password: string }, actor: Actor) {
  if (u.password.length < 8) throw badRequest('密码至少 8 位');
  const [row] = await tx`INSERT INTO app_user (username, display_name, role, password_hash) VALUES (${u.username}, ${u.displayName}, ${u.role}, ${await hashPassword(u.password)}) RETURNING id`;
  await audit(tx, actor, 'user.create', 'USER', String(row.id), `新增用户 ${u.displayName}（${u.role}）`);
  return String(row.id);
}

export async function updateUser(tx: Tx, id: string, u: { displayName?: string; role?: Role; status?: 'ACTIVE' | 'DISABLED'; password?: string }, actor: Actor) {
  const [cur] = await tx`SELECT * FROM app_user WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound('用户');
  if (id === actor.id && (u.role && u.role !== 'ADMIN' || u.status === 'DISABLED')) throw badRequest('不能停用自己或取消自己的管理员身份');
  if (u.password !== undefined && u.password.length < 8) throw badRequest('密码至少 8 位');
  if ((u.role && u.role !== 'ADMIN') || u.status === 'DISABLED') {
    const [{ n }] = await tx`SELECT count(*)::int AS n FROM app_user WHERE role = 'ADMIN' AND status = 'ACTIVE' AND id <> ${id}`;
    if (cur.role === 'ADMIN' && n === 0) throw badRequest('至少保留一名有效的管理员');
  }
  await tx`UPDATE app_user SET display_name = ${u.displayName ?? cur.display_name}, role = ${u.role ?? cur.role}, status = ${u.status ?? cur.status},
             password_hash = ${u.password ? await hashPassword(u.password) : cur.password_hash}, failed_logins = ${u.password ? 0 : cur.failed_logins},
             locked_until = ${u.password ? null : cur.locked_until}
           WHERE id = ${id}`;
  await audit(tx, actor, u.password ? 'user.resetPassword' : 'user.update', 'USER', id, `${u.password ? '重置密码' : '修改用户'} ${cur.display_name}`);
}
