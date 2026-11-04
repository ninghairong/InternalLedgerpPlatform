// 税负测算（管理口径，不作为申报依据）。按主体在所属期适用的纳税人身份计算；税率来自税务规则字典。
import { isLive } from './selectors';
import type { Account, Entity, Flow, Invoice, TaxProfile, TaxRule } from './types';

export interface TaxRow {
  key: string;
  entityId: string;
  period: string; // YYYY-MM 或 YYYY-Qn
  taxpayerType: TaxProfile['taxpayerType'];
  sales: number; // 不含税销售额
  outTax: number;
  inTax: number; // 可抵扣进项
  inNonDeduct: number; // 不可抵扣进项（计入成本）
  vat: number;
  surcharge: number;
  paidVat: number;
  note: string;
}

export function profileAt(e: Entity, date: string): TaxProfile {
  const hit = [...e.taxProfiles].reverse().find((p) => p.validFrom <= date && (!p.validTo || date < p.validTo));
  return hit ?? e.taxProfiles[0] ?? { taxpayerType: e.taxpayerType, vatFiling: e.vatFiling, validFrom: '2000-01-01', urbanRate: 0.05, halving: e.taxpayerType === 'SMALL' };
}

export const periodKey = (date: string, filing: 'MONTH' | 'QUARTER') =>
  filing === 'MONTH' ? date.slice(0, 7) : `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;

const periodStart = (period: string) => (period.includes('Q') ? `${period.slice(0, 4)}-${String((Number(period.slice(6)) - 1) * 3 + 1).padStart(2, '0')}-01` : `${period}-01`);

function ruleAt(rules: TaxRule[], tax: TaxRule['tax'], date: string, taxpayer?: TaxProfile['taxpayerType']) {
  return rules
    .filter((r) => r.tax === tax && (!r.taxpayer || r.taxpayer === taxpayer) && r.validFrom <= date && (!r.validTo || date < r.validTo))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
}

export function taxAssessments(data: { entities: Entity[]; invoices: Invoice[]; flows: Flow[]; accounts: Account[]; taxRules: TaxRule[] }, entityIds?: Set<string>): TaxRow[] {
  const acc = new Map(data.accounts.map((a) => [a.id, a]));
  const out: TaxRow[] = [];
  for (const e of data.entities) {
    if (entityIds && !entityIds.has(e.id)) continue;
    const byPeriod = new Map<string, { list: Invoice[]; profile: TaxProfile }>();
    for (const i of data.invoices.filter((x) => x.entityId === e.id)) {
      const prof = profileAt(e, i.issueDate);
      const p = periodKey(i.issueDate, prof.vatFiling);
      const cur = byPeriod.get(p) ?? { list: [], profile: profileAt(e, periodStart(p)) };
      cur.list.push(i);
      byPeriod.set(p, cur);
    }
    for (const [period, { list, profile }] of byPeriod) {
      const start = periodStart(period);
      const outs = list.filter((i) => i.direction === 'OUTPUT');
      const ins = list.filter((i) => i.direction === 'INPUT');
      const sales = outs.reduce((s, i) => s + i.amountExclTax, 0);
      const outTax = outs.reduce((s, i) => s + i.taxAmount, 0);
      const general = profile.taxpayerType === 'GENERAL';
      const inTax = general ? ins.filter((i) => i.type === 'VAT_SPECIAL').reduce((s, i) => s + i.taxAmount, 0) : 0;
      const inNonDeduct = ins.reduce((s, i) => s + i.taxAmount, 0) - inTax;
      let vat: number;
      let note: string;
      if (general) {
        vat = Math.max(0, outTax - inTax);
        note = outTax < inTax ? `留抵 ${((inTax - outTax) / 100).toFixed(2)}` : '销项 − 可抵扣进项';
      } else {
        const rule = ruleAt(data.taxRules, 'VAT', start, 'SMALL');
        const rate = rule?.rate ?? 0.01;
        const threshold = rule?.thresholdAmount ?? 0;
        const quarterly = rule?.thresholdPeriod === 'QUARTER' || profile.vatFiling === 'QUARTER';
        if (threshold && sales <= threshold * (quarterly ? 1 : 1 / 3) && outs.every((i) => i.type === 'VAT_NORMAL')) {
          vat = 0;
          note = `销售额 ${(sales / 100).toFixed(2)} 未超过免征额，免征`;
        } else {
          vat = Math.round(sales * rate);
          note = `销售额 × ${Math.round(rate * 1000) / 10}%`;
        }
      }
      const edu = ruleAt(data.taxRules, 'EDU_SURCHARGE', start)?.rate ?? 0.03;
      const localEdu = ruleAt(data.taxRules, 'LOCAL_EDU_SURCHARGE', start)?.rate ?? 0.02;
      const surcharge = Math.round(vat * (profile.urbanRate + edu + localEdu) * (profile.halving ? 0.5 : 1));
      const paidVat = data.flows
        .filter((f) => isLive(f) && acc.get(f.fromAccountId)?.entityId === e.id)
        .flatMap((f) => f.splits)
        .filter((s) => s.tax === 'VAT' && s.taxPeriod === period)
        .reduce((s, x) => s + x.amount, 0);
      out.push({ key: `${e.id}-${period}`, entityId: e.id, period, taxpayerType: profile.taxpayerType, sales, outTax, inTax, inNonDeduct, vat, surcharge, paidVat, note });
    }
  }
  return out.sort((a, b) => b.period.localeCompare(a.period) || a.entityId.localeCompare(b.entityId));
}
