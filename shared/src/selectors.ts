// 由流水派生的数据：余额、资金批次（lot）、来源分配、资金链、项目汇总。
// 正式系统中这些由后端计算（见 docs/需求方案.md §3.3、§8.4），原型在前端模拟。
import type { Account, AccountKind, Allocation, Category, Entity, Flow, ID, Project, Writeoff } from './types';

/** 有效流水（未作废、未冲销） */
export const isLive = (f: Flow) => f.status === 'CONFIRMED';

/** 员工手中的公司资金：需要滞留预警的账户类型 */
export const isHeldByPerson = (kind?: AccountKind) => kind === 'INTERNAL_PERSONAL' || kind === 'CASH';

export function balances(flows: Flow[]): Map<ID, number> {
  const m = new Map<ID, number>();
  for (const f of flows) {
    if (!isLive(f)) continue;
    m.set(f.fromAccountId, (m.get(f.fromAccountId) ?? 0) - f.amount);
    m.set(f.toAccountId, (m.get(f.toAccountId) ?? 0) + f.amount);
  }
  return m;
}

export interface Lot {
  flowId: ID;
  accountId: ID;
  date: string;
  projectIds: ID[];
  original: number;
  remaining: number;
}

/** 流入溯源账户（REQUIRED / OPTIONAL）的每笔有效流水都是一个 lot */
export function lots(flows: Flow[], accounts: Account[], excludeOutFlowId?: ID, writeoffs: Writeoff[] = []): Map<ID, Lot> {
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const m = new Map<ID, Lot>();
  for (const f of flows) {
    if (!isLive(f)) continue;
    if ((acc.get(f.toAccountId)?.trace ?? 'NONE') === 'NONE') continue;
    m.set(f.id, { flowId: f.id, accountId: f.toAccountId, date: f.date, projectIds: f.splits.map((s) => s.projectId), original: f.amount, remaining: f.amount });
  }
  for (const f of flows) {
    if (!isLive(f) || f.id === excludeOutFlowId) continue;
    for (const a of f.allocations) {
      const l = m.get(a.lotFlowId);
      if (l) l.remaining -= a.amount;
    }
  }
  for (const w of writeoffs) {
    const l = m.get(w.lotFlowId);
    if (l) l.remaining -= w.amount;
  }
  return m;
}

export interface AllocOptions {
  asOf?: string; // 只能使用该日期及之前的入款
  excludeOutFlowId?: ID;
  preferProjectId?: ID; // 同项目的入款优先
}

/** 可用入款，按分配优先级排序：同项目优先，再先进先出 */
export function openLotsOf(flows: Flow[], accounts: Account[], accountId: ID, opts: AllocOptions = {}): Lot[] {
  const same = (l: Lot) => (opts.preferProjectId && l.projectIds.includes(opts.preferProjectId) ? 0 : 1);
  return [...lots(flows, accounts, opts.excludeOutFlowId).values()]
    .filter((l) => l.accountId === accountId && l.remaining > 0 && (!opts.asOf || l.date <= opts.asOf))
    .sort((a, b) => same(a) - same(b) || a.date.localeCompare(b.date) || a.flowId.localeCompare(b.flowId));
}

export type AllocResult = { ok: true; allocations: Allocation[] } | { ok: false; available: number; allocations: Allocation[] };

/** 默认分配：同项目的入款优先，再从最早的未用完入款开始扣 */
export function autoAllocate(flows: Flow[], accounts: Account[], accountId: ID, amount: number, opts: AllocOptions = {}): AllocResult {
  const open = openLotsOf(flows, accounts, accountId, opts);
  const allocations: Allocation[] = [];
  let need = amount;
  for (const l of open) {
    if (need <= 0) break;
    const take = Math.min(need, l.remaining);
    allocations.push({ lotFlowId: l.flowId, amount: take, auto: true });
    need -= take;
  }
  if (need > 0) return { ok: false, available: amount - need, allocations };
  return { ok: true, allocations };
}

// ---------------------------------------------------------------- 资金链

export type TraceStatus = 'OPEN' | 'CLOSED' | 'ABNORMAL';

export interface TraceEdge {
  flowId: ID;
  from: ID;
  to: ID;
  depth: number;
  value: number; // 该流水中归属于本链的金额（合并资金按比例）
}

export interface Trace {
  id: ID; // = 根流水 id
  rootFlowId: ID;
  originEntityId?: ID; // 资金首次进入的主体
  rootAmount: number;
  held: number; // 滞留在个人卡 / 现金
  retained: number; // 留存在对公账户、尚未使用
  landed: number; // 已落地为费用 / 税费
  outflow: number; // 往来款付给外部（借出、还款等），正常结束
  external: number; // 以内部划转方式交给外部（如现金交付）后未转回、也未说明
  writtenOff: number; // 外部差额已说明并核销
  viaPerson: boolean; // 是否经过个人卡 / 现金
  edges: TraceEdge[];
  oldestHeldDate?: string;
  lastDate: string;
  status: TraceStatus;
  reasons: string[];
}

export const STALE_DAYS = 30;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * 根 = 资金从平台外（外部单位、期初、银行结息等）进入溯源账户的那一笔。
 * 公户、个人卡、现金都强制溯源，所以每一笔外部来款都能一路追到最终落地。
 * 从根出发沿 allocation 向下游展开，按金额比例把根资金分摊到每一步。
 */
export function computeTraces(flows: Flow[], accounts: Account[], categories: Category[], today: string, writeoffs: Writeoff[] = []): Trace[] {
  const woByLot = new Map<ID, number>();
  for (const w of writeoffs) woByLot.set(w.lotFlowId, (woByLot.get(w.lotFlowId) ?? 0) + w.amount);
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const cat = new Map(categories.map((c) => [c.id, c]));
  const live = flows.filter(isLive);
  const byLot = new Map<ID, { out: Flow; amount: number }[]>();
  for (const f of live) {
    for (const a of f.allocations) {
      if (!byLot.has(a.lotFlowId)) byLot.set(a.lotFlowId, []);
      byLot.get(a.lotFlowId)!.push({ out: f, amount: a.amount });
    }
  }

  const roots = live.filter((f) => acc.get(f.toAccountId)?.trace === 'REQUIRED' && acc.get(f.fromAccountId)?.trace !== 'REQUIRED' && f.allocations.length === 0);

  return roots.map((root) => {
    const t: Trace = {
      id: root.id, rootFlowId: root.id, originEntityId: acc.get(root.toAccountId)?.entityId, rootAmount: root.amount,
      held: 0, retained: 0, landed: 0, outflow: 0, external: 0, writtenOff: 0, viaPerson: false, edges: [], lastDate: root.date, status: 'CLOSED', reasons: [],
    };
    const visit = (f: Flow, attributed: number, depth: number) => {
      t.edges.push({ flowId: f.id, from: f.fromAccountId, to: f.toAccountId, depth, value: attributed });
      if (f.date > t.lastDate) t.lastDate = f.date;
      const to = acc.get(f.toAccountId)!;
      if (isHeldByPerson(to.kind)) t.viaPerson = true;
      const isExpense = f.splits.some((s) => cat.get(s.categoryId)?.affectsPnl && cat.get(s.categoryId)?.nature !== 'INCOME');
      if (to.trace === 'NONE' || (isExpense && to.kind === 'EXTERNAL')) {
        t.landed += attributed;
        return;
      }
      const ratio = attributed / f.amount;
      let used = 0;
      for (const { out, amount } of byLot.get(f.id) ?? []) {
        const part = amount * ratio;
        used += part;
        visit(out, part, depth + 1);
      }
      let rest = attributed - used;
      const wo = (woByLot.get(f.id) ?? 0) * ratio;
      if (wo > 0) {
        t.writtenOff += Math.min(wo, rest);
        rest -= Math.min(wo, rest);
      }
      if (rest < 0.5) return;
      if (isHeldByPerson(to.kind)) {
        t.held += rest;
        if (!t.oldestHeldDate || f.date < t.oldestHeldDate) t.oldestHeldDate = f.date;
      } else if (to.kind === 'CORPORATE') t.retained += rest;
      else if (f.splits.every((s) => cat.get(s.categoryId)?.nature === 'CURRENT')) t.outflow += rest;
      else t.external += rest;
    };
    visit(root, root.amount, 0);

    if (t.held >= 0.5 || t.retained >= 0.5) t.status = 'OPEN';
    if (t.held >= 0.5 && t.oldestHeldDate && daysBetween(t.oldestHeldDate, today) > STALE_DAYS) {
      t.status = 'ABNORMAL';
      t.reasons.push(`个人/现金账户资金滞留超过 ${STALE_DAYS} 天`);
    }
    if (t.external >= 0.5) {
      t.status = 'ABNORMAL';
      t.reasons.push('外部账户存在差额待说明');
    }
    return t;
  });
}

// ---------------------------------------------------------------- 主体 / 项目

/** 流水是否与主体相关：任一端为该主体对公账户，或分摊到该主体的项目 */
export function flowTouchesEntity(f: Flow, entityId: ID, accMap: Map<ID, Account>, projMap: Map<ID, Project>): boolean {
  if (accMap.get(f.fromAccountId)?.entityId === entityId) return true;
  if (accMap.get(f.toAccountId)?.entityId === entityId) return true;
  return f.splits.some((s) => projMap.get(s.projectId)?.entityId === entityId);
}

export const topCategoryId = (catMap: Map<ID, Category>, id: ID) => catMap.get(id)?.parentId ?? id;

export interface ProjectStat {
  income: number;
  expense: number;
  byTop: Record<ID, number>; // 一级类型 → 支出
  flowCount: number;
}

export function projectStats(flows: Flow[], categories: Category[]): Map<ID, ProjectStat> {
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const m = new Map<ID, ProjectStat>();
  for (const f of flows) {
    if (!isLive(f)) continue;
    for (const s of f.splits) {
      const st = m.get(s.projectId) ?? { income: 0, expense: 0, byTop: {}, flowCount: 0 };
      st.flowCount++;
      const ct = catMap.get(s.categoryId);
      if (ct?.affectsPnl) {
        if (ct.nature === 'INCOME') st.income += s.amount;
        else {
          st.expense += s.amount;
          const top = topCategoryId(catMap, s.categoryId);
          st.byTop[top] = (st.byTop[top] ?? 0) + s.amount;
        }
      }
      m.set(s.projectId, st);
    }
  }
  return m;
}

export function entityName(entities: Entity[], id?: ID) {
  return entities.find((e) => e.id === id)?.shortName ?? '—';
}
