// 导出：所有文件在服务端生成，带数据范围 / 导出人 / 时间水印，并记录审计日志。
import ExcelJS from 'exceljs';
import { buildFlowsExport, buildJournalExport, buildTableExport, buildTemplate, buildTracesExport, categoryPath, type CellInput, type ExportMeta, type TemplateCode,
  ACCOUNT_KIND_TEXT, ENTITY_KIND_TEXT, FILING_TEXT, PROJECT_STATUS_TEXT, TAXPAYER_TEXT, VAT_METHOD_TEXT, BUDGET_KEYS } from '@ledger/shared/excel';
import { balances, computeTraces, flowTouchesEntity, isLive, projectStats } from '@ledger/shared/selectors';
import { taxAssessments } from '@ledger/shared/tax';
import { ACCOUNT_KIND } from '@ledger/shared/labels';
import { today } from '@ledger/shared/format';
import type { Snapshot } from '@ledger/shared/types';
import type { Sql } from '../db';
import { audit, type Actor } from '../audit';
import { badRequest, notFound } from '../errors';
import { loadSnapshot } from '../snapshot';

export interface ExportQuery {
  ids?: string[]; // 按页面当前列表导出（所见即所得）
  title?: string;
  entityId?: string;
  accountId?: string;
  projectId?: string;
  from?: string;
  to?: string;
}

const yuan = (c: number) => Math.round(c) / 100;

function scoped(snap: Snapshot, q: ExportQuery) {
  const accMap = new Map(snap.accounts.map((a) => [a.id, a]));
  const projMap = new Map(snap.projects.map((p) => [p.id, p]));
  const ids = q.ids ? new Set(q.ids) : undefined;
  return snap.flows.filter(
    (f) =>
      (!ids || ids.has(f.id)) &&
      (!q.entityId || flowTouchesEntity(f, q.entityId, accMap, projMap)) &&
      (!q.accountId || f.fromAccountId === q.accountId || f.toAccountId === q.accountId) &&
      (!q.projectId || f.splits.some((s) => s.projectId === q.projectId)) &&
      (!q.from || f.date >= q.from) &&
      (!q.to || f.date <= q.to),
  );
}

export async function runExport(sql: Sql, kind: string, q: ExportQuery, actor: Actor): Promise<{ fileName: string; buffer: Buffer }> {
  const snap = await loadSnapshot(sql);
  const entity = q.entityId ? snap.entities.find((e) => e.id === q.entityId) : undefined;
  if (q.entityId && !entity) throw notFound('主体');
  const meta: ExportMeta = { scopeLabel: entity?.name ?? '全部主体', exporter: actor.displayName, exportedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) };
  const stamp = today();
  let wb: ExcelJS.Workbook;
  let name: string;
  let rows = 0;

  switch (kind) {
    case 'flows': {
      const list = scoped(snap, q);
      const proj = q.projectId ? snap.projects.find((p) => p.id === q.projectId) : undefined;
      name = q.title?.replace(/[\\/:*?"<>|]/g, '') || (proj ? `${proj.name}_流水` : '资金流水明细');
      wb = buildFlowsExport(list, snap, name, meta);
      rows = list.length;
      break;
    }
    case 'journal': {
      const acc = snap.accounts.find((a) => a.id === q.accountId);
      if (!acc) throw badRequest('请选择账户');
      name = `${acc.name}_日记账`;
      wb = buildJournalExport(acc, snap, meta, { from: q.from, to: q.to });
      break;
    }
    case 'traces': {
      const accMap = new Map(snap.accounts.map((a) => [a.id, a]));
      const projMap = new Map(snap.projects.map((p) => [p.id, p]));
      const byId = new Map(snap.flows.map((f) => [f.id, f]));
      const traces = computeTraces(snap.flows, snap.accounts, snap.categories, today(), snap.writeoffs).filter(
        (t) => !q.entityId || t.edges.some((e) => flowTouchesEntity(byId.get(e.flowId)!, q.entityId!, accMap, projMap)),
      );
      name = '资金链明细';
      wb = buildTracesExport(traces, snap, meta);
      rows = traces.length;
      break;
    }
    case 'balances': {
      const bal = balances(snap.flows);
      const list = snap.accounts.filter((a) => a.kind !== 'VIRTUAL' && a.kind !== 'EXTERNAL' && (!q.entityId || a.entityId === q.entityId));
      name = '账户余额表';
      wb = buildTableExport(
        name,
        [{ header: '编号', width: 12 }, { header: '账户', width: 30 }, { header: '类型', width: 10 }, { header: '主体', width: 14 }, { header: '持有人', width: 10 }, { header: '开户行', width: 14 }, { header: '尾号', width: 8 }, { header: '余额', width: 16, money: true }],
        list.map((a) => [a.code, a.name, ACCOUNT_KIND[a.kind].label, snap.entities.find((e) => e.id === a.entityId)?.shortName ?? '', a.holder ?? '', a.bank ?? '', a.last4 ?? '', yuan(bal.get(a.id) ?? 0)]),
        meta,
      );
      rows = list.length;
      break;
    }
    case 'projects': {
      const stats = projectStats(snap.flows, snap.categories);
      const tops = snap.categories.filter((c) => !c.parentId && c.nature === 'EXPENSE');
      const list = snap.projects.filter((p) => !q.entityId || p.entityId === q.entityId);
      name = '项目收支汇总';
      wb = buildTableExport(
        name,
        [{ header: '编号', width: 14 }, { header: '项目', width: 34 }, { header: '主体', width: 12 }, { header: '状态', width: 8 }, { header: '合同额', width: 14, money: true }, { header: '收入', width: 14, money: true }, ...tops.map((c) => ({ header: c.name, width: 12, money: true })), { header: '支出合计', width: 14, money: true }, { header: '预算', width: 14, money: true }, { header: '收支差', width: 14, money: true }],
        list.map((p) => {
          const st = stats.get(p.id);
          return [p.code, p.name, snap.entities.find((e) => e.id === p.entityId)?.shortName, PROJECT_STATUS_TEXT[p.status], yuan(p.contractAmount), yuan(st?.income ?? 0), ...tops.map((c) => yuan(st?.byTop[c.id] ?? 0)), yuan(st?.expense ?? 0), yuan(Object.values(p.budget).reduce((a, b) => a + b, 0)), yuan((st?.income ?? 0) - (st?.expense ?? 0))];
        }),
        meta,
      );
      rows = list.length;
      break;
    }
    case 'settlement': {
      const p = snap.projects.find((x) => x.id === q.projectId);
      if (!p) throw badRequest('请选择项目');
      const st = projectStats(snap.flows, snap.categories).get(p.id);
      const tops = snap.categories.filter((c) => !c.parentId && c.nature === 'EXPENSE');
      const tax = taxAssessments({ ...snap, invoices: snap.invoices.filter((i) => i.projectId === p.id) }, new Set([p.entityId]));
      const vat = tax.reduce((s, r) => s + r.vat, 0);
      const surcharge = tax.reduce((s, r) => s + r.surcharge, 0);
      name = `${p.name}_结算单`;
      wb = buildTableExport(
        name,
        [{ header: '项目', width: 22 }, { header: '金额（元）', width: 18, money: true }, { header: '说明', width: 50 }],
        [
          ['合同额', yuan(p.contractAmount), ''],
          ['已收款', yuan(st?.income ?? 0), '项目收入类流水合计'],
          ...tops.filter((c) => p.budget[c.id] || st?.byTop[c.id]).map((c) => [`支出-${c.name}`, yuan(st?.byTop[c.id] ?? 0), `预算 ${yuan(p.budget[c.id] ?? 0)}`]),
          ['支出合计', yuan(st?.expense ?? 0), '不含内部划转、往来款'],
          ['增值税（估）', yuan(vat), '按项目发票测算，管理口径'],
          ['附加税（估）', yuan(surcharge), ''],
          ['毛利（估）', yuan((st?.income ?? 0) - (st?.expense ?? 0) - surcharge), '收入 − 支出 − 附加税'],
        ],
        meta,
      );
      break;
    }
    case 'ic': {
      const m = new Map<string, number>();
      for (const f of snap.flows) {
        if (!f.icNature || !isLive(f)) continue;
        const a = snap.accounts.find((x) => x.id === f.fromAccountId)!.entityId!;
        const b = snap.accounts.find((x) => x.id === f.toAccountId)!.entityId!;
        m.set(`${a}|${b}`, (m.get(`${a}|${b}`) ?? 0) + f.amount);
        m.set(`${b}|${a}`, (m.get(`${b}|${a}`) ?? 0) - f.amount);
      }
      const ent = (id: string) => snap.entities.find((e) => e.id === id)?.shortName;
      const list = [...m.entries()].filter(([k, v]) => v && (!q.entityId || k.startsWith(`${q.entityId}|`)));
      name = '集团内往来余额';
      wb = buildTableExport(name, [{ header: '主体', width: 16 }, { header: '对方主体', width: 16 }, { header: '净额（正数 = 应收对方）', width: 22, money: true }], list.map(([k, v]) => [ent(k.split('|')[0]), ent(k.split('|')[1]), yuan(v)]), meta);
      rows = list.length;
      break;
    }
    case 'tax': {
      const list = taxAssessments(snap, q.entityId ? new Set([q.entityId]) : undefined);
      name = '税负测算';
      wb = buildTableExport(
        name,
        [{ header: '主体', width: 14 }, { header: '身份', width: 12 }, { header: '所属期', width: 10 }, { header: '不含税销售额', width: 16, money: true }, { header: '销项税额', width: 14, money: true }, { header: '可抵扣进项', width: 14, money: true }, { header: '不可抵扣进项', width: 14, money: true }, { header: '应纳增值税', width: 14, money: true }, { header: '附加税', width: 12, money: true }, { header: '已缴增值税', width: 14, money: true }, { header: '说明', width: 30 }],
        list.map((r) => [snap.entities.find((e) => e.id === r.entityId)?.shortName, TAXPAYER_TEXT[r.taxpayerType], r.period, yuan(r.sales), yuan(r.outTax), yuan(r.inTax), yuan(r.inNonDeduct), yuan(r.vat), yuan(r.surcharge), yuan(r.paidVat), r.note]),
        meta,
      );
      rows = list.length;
      break;
    }
    case 'payroll': {
      const list = snap.payrolls.filter((p) => !p.voided && (!q.entityId || p.entityId === q.entityId));
      name = '工资汇总';
      wb = buildTableExport(
        name,
        [{ header: '主体', width: 14 }, { header: '月份', width: 10 }, { header: '批次', width: 6 }, { header: '人员', width: 10 }, { header: '应发', width: 12, money: true }, { header: '社保个人', width: 12, money: true }, { header: '公积金个人', width: 12, money: true }, { header: '个税', width: 12, money: true }, { header: '其他扣款', width: 12, money: true }, { header: '实发', width: 12, money: true }, { header: '社保单位', width: 12, money: true }, { header: '公积金单位', width: 12, money: true }],
        list.flatMap((p) => p.items.map((i) => [snap.entities.find((e) => e.id === p.entityId)?.shortName, p.month, p.seq, i.person, yuan(i.gross), yuan(i.siPersonal), yuan(i.hfPersonal), yuan(i.iit), yuan(i.otherDeduct), yuan(i.net), yuan(i.siCompany), yuan(i.hfCompany)])),
        meta,
      );
      rows = list.reduce((s, p) => s + p.items.length, 0);
      break;
    }
    default:
      throw badRequest(`未知的导出类型 ${kind}`);
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  await audit(sql, actor, 'export.run', 'EXPORT', kind, `导出 ${name}.xlsx${rows ? `（${rows} 行）` : ''}`, { ...q, ids: q.ids ? `${q.ids.length} 笔` : undefined });
  return { fileName: `${name}_${stamp}.xlsx`, buffer };
}

/** 模板下载；fill=true 时把现有主数据回填进模板，修改后可再导入（按编号更新） */
export async function buildTemplateFile(sql: Sql, code: TemplateCode, opts: { accountId?: string; fill?: boolean }) {
  const snap = await loadSnapshot(sql);
  const ent = (id?: string) => snap.entities.find((e) => e.id === id)?.name ?? null;
  const header: Record<string, CellInput> = {};
  let rows: CellInput[][] = [];
  if ((code === 'JOURNAL' || code === 'PAYROLL') && opts.accountId) {
    const a = snap.accounts.find((x) => x.id === opts.accountId);
    if (!a) throw notFound('账户');
    header.account = a.name;
    header.payAccount = a.kind === 'CORPORATE' ? a.name : null;
    header.entity = ent(a.entityId);
  }
  if (opts.fill) {
    const yuanOrNull = (c?: number) => (c ? yuan(c) : null);
    if (code === 'ENTITY')
      rows = snap.entities.map((e) => {
        const p = e.taxProfiles[e.taxProfiles.length - 1];
        return [e.code, e.name, e.shortName, ENTITY_KIND_TEXT[e.kind], ent(e.parentId), TAXPAYER_TEXT[e.taxpayerType], p ? new Date(`${p.validFrom}T00:00:00Z`) : null, FILING_TEXT[e.vatFiling], p ? `${Math.round(p.urbanRate * 100)}%` : null, p?.halving ? '是' : '否', e.region, e.uscc ?? null];
      });
    if (code === 'ACCOUNT')
      rows = snap.accounts.filter((a) => a.kind !== 'VIRTUAL').map((a) => [a.code, a.name, ACCOUNT_KIND_TEXT[a.kind as keyof typeof ACCOUNT_KIND_TEXT], ent(a.entityId), a.holder ?? null, a.bank ?? null, a.last4 ?? null, null, null, null, a.remark ?? null]);
    if (code === 'PROJECT')
      rows = snap.projects.filter((p) => p.kind === 'NORMAL').map((p) => [p.code, p.name, ent(p.entityId), p.manager, p.customer ?? null, p.region ?? null, VAT_METHOD_TEXT[p.vatMethod], yuanOrNull(p.contractAmount), ...Object.values(BUDGET_KEYS).map((k) => yuanOrNull(p.budget[k])), p.startDate ? new Date(`${p.startDate}T00:00:00Z`) : null, PROJECT_STATUS_TEXT[p.status]]);
  }
  const wb = buildTemplate(code, snap, { header, rows });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export { categoryPath };
