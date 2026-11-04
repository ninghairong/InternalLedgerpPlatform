// 导入校验与提交计划：解析 → 规范化 → 名称识别 → 主数据（主体/账户/项目）→ 按日期模拟入账（含强制溯源）→ 预览。
// 前端用于即时预览，后端在提交时用同一份代码对最新数据重新校验后再写库。
import { isLive } from './selectors';
import { FLOW_METHOD, IC_NATURE, TAX_KIND } from './labels';
import {
  ACCOUNT_KIND_TEXT, BUDGET_KEYS, ENTITY_KIND_TEXT, FILING_TEXT, PROJECT_STATUS_TEXT, TAXPAYER_TEXT, VAT_METHOD_TEXT,
  type ParsedSheet, type TemplateCode,
} from './excel';
import type { Account, Allocation, Entity, Flow, FlowMethod, IcNature, ID, LedgerData, Project, TaxKind, TaxProfile } from './types';
import { money } from './format';

export type RowStatus = 'OK' | 'WARNING' | 'ERROR' | 'DUPLICATE' | 'MATCHED' | 'SKIPPED';

export interface RowMessage {
  level: 'error' | 'warning' | 'info';
  field?: string;
  text: string;
}

/** 新建流水的输入（id、流水号由后端生成）；tempId 用于同一批次内互相引用资金来源 */
export type NewFlowInput = Omit<Flow, 'id' | 'flowNo' | 'createdAt' | 'status' | 'attachmentCount' | 'createdBy' | 'reversalReason'> & { tempId?: string };

export type MasterOp =
  | { type: 'ENTITY'; op: 'CREATE' | 'UPDATE'; id: ID; data: Entity; newProfile?: TaxProfile; commonProjectId?: ID }
  | { type: 'ACCOUNT'; op: 'CREATE' | 'UPDATE'; id: ID; data: Account }
  | { type: 'PROJECT'; op: 'CREATE' | 'UPDATE'; id: ID; data: Project };

export interface PayrollLine {
  batchKey: string; // 同一 Sheet 为一个工资批次
  entityId: ID;
  month: string; // YYYY-MM
  payDate: string;
  payAccountId: ID;
  person: string;
  idLast4?: string;
  gross: number;
  siPersonal: number;
  hfPersonal: number;
  iit: number;
  otherDeduct: number;
  net: number;
  siCompany: number;
  hfCompany: number;
  payeeAccountId: ID;
}

export interface ImportRow {
  key: string;
  file: string;
  sheet: string;
  template: TemplateCode;
  rowNo: number;
  rowRef?: string;
  chainNo?: string;
  status: RowStatus;
  messages: RowMessage[];
  raw: Record<string, unknown>;
  flow?: NewFlowInput & { tempId: string };
  newAccount?: Account; // 对方户名/收款人不存在时自动新建的外部账户
  master?: MasterOp;
  payroll?: PayrollLine;
  selfAccountId?: ID; // 日记账所属账户
}

export interface ImportFile {
  name: string;
  sheets: ParsedSheet[];
}

/** 解析结果转为可 JSON 存储的形式：日期单元格转成 YYYY-MM-DD 文本（parseDate 可识别） */
export function serializeFiles(files: ImportFile[]): ImportFile[] {
  const conv = (v: unknown) => (v instanceof Date ? parseDate(v) : v);
  return files.map((f) => ({
    name: f.name,
    sheets: f.sheets.map((sh) => ({
      ...sh,
      header: Object.fromEntries(Object.entries(sh.header).map(([k, v]) => [k, conv(v)])),
      rows: sh.rows.map((r) => ({ rowNo: r.rowNo, values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, conv(v)])) })),
    })),
  }));
}

const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')');

function lev(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** 名称识别：精确（名称/编号/持有人）→ 近似（编辑距离 1，需人工确认） */
function resolveAccount(accounts: Account[], name: unknown): { account?: Account; fuzzy?: boolean } {
  const n = norm(name);
  if (!n) return {};
  const live = accounts.filter((a) => a.status === 'ACTIVE');
  const exact = live.find((a) => norm(a.name) === n || a.code === n) ?? live.find((a) => a.holder && norm(a.holder) === n && a.kind === 'INTERNAL_PERSONAL');
  if (exact) return { account: exact };
  const near = live.filter((a) => lev(norm(a.name), n) <= 1 || (a.holder && a.kind !== 'EXTERNAL' && lev(norm(a.holder), n) <= 1));
  if (near.length === 1) return { account: near[0], fuzzy: true };
  return {};
}

const resolveEntity = (entities: Entity[], v: unknown) => {
  const n = norm(v);
  return n ? entities.find((e) => norm(e.name) === n || e.code === n || norm(e.shortName) === n) : undefined;
};
const resolveProject = (projects: Project[], v: unknown) => {
  const n = norm(v);
  return n ? projects.find((p) => norm(p.name) === n || p.code === n) : undefined;
};

export function parseDate(v: unknown): string | undefined {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  const m = /^(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?$/.exec(String(v ?? '').trim());
  if (!m) return undefined;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return new Date(`${iso}T00:00:00Z`).getUTCDate() === d ? iso : undefined;
}

function parseMonth(v: unknown): string | undefined {
  const asDate = parseDate(v);
  if (asDate) return asDate.slice(0, 7);
  const m = /^(\d{4})[-./年](\d{1,2})月?$/.exec(String(v ?? '').trim());
  if (!m || +m[2] < 1 || +m[2] > 12) return undefined;
  return `${m[1]}-${m[2].padStart(2, '0')}`;
}

function parseAmount(v: unknown): { cents?: number; negative?: boolean; bad?: boolean } {
  if (v === undefined || v === null || v === '') return {};
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,，¥\s]/g, ''));
  if (!Number.isFinite(n)) return { bad: true };
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return { bad: true };
  return { cents: Math.round(Math.abs(n) * 100), negative: n < 0 };
}

const revLookup = <K extends string>(map: Record<K, string>, label: unknown) => (Object.entries(map) as [K, string][]).find(([, l]) => l === String(label ?? '').trim())?.[0];

export const rowKey = (file: string, sheet: string, rowNo: number) => `${file}|${sheet}|${rowNo}`;

const ORDER: TemplateCode[] = ['ENTITY', 'ACCOUNT', 'PROJECT', 'JOURNAL', 'FLOW', 'PAYROLL'];

/**
 * skip：用户选择跳过的行（跳过后重新校验，依赖它的行会随之报错）。
 * 返回的行按"文件 → Sheet → 行号"排列，便于用户对照原表。
 */
export interface ValidateOptions {
  skip?: Set<string>;
  today?: string;
  closedPeriods?: Set<string>; // `${entityId}|YYYY-MM`
}

export function validate(files: ImportFile[], ctx: LedgerData, opts: ValidateOptions = {}): ImportRow[] {
  // 复制一份，校验过程中新增 / 更新的主数据不影响调用方的数据
  const entities = ctx.entities.map((e) => ({ ...e }));
  const accounts = ctx.accounts.map((a) => ({ ...a }));
  const projects = ctx.projects.map((p) => ({ ...p }));
  const { categories } = ctx;
  const skip = opts.skip ?? new Set<string>();
  const todayStr = opts.today ?? new Date().toISOString().slice(0, 10);
  const rows: ImportRow[] = [];
  const newCounterparties = new Map<string, Account>();
  let tempSeq = 0;
  const tempId = (p: string) => `new-${p}-${++tempSeq}`;

  const categoryByPath = (path: unknown) => {
    const [p, c] = String(path ?? '').split('/').map((s) => s.trim());
    const parent = categories.find((x) => !x.parentId && x.name === p);
    return categories.find((x) => x.parentId === parent?.id && x.name === c);
  };

  const sheets = files.flatMap((file) => file.sheets.map((sh) => ({ file, sh }))).sort((a, b) => ORDER.indexOf(a.sh.template) - ORDER.indexOf(b.sh.template));

  for (const { file, sh } of sheets) {
    const sheetMsgs: RowMessage[] = [];
    let self: Account | undefined;
    let payroll: { entity?: Entity; month?: string; payDate?: string; payAccount?: Account } = {};
    if (sh.template === 'JOURNAL') {
      self = resolveAccount(accounts, sh.header.account).account;
      if (!self) sheetMsgs.push({ level: 'error', text: `表头"账户"「${sh.header.account || '空'}」未找到` });
      else if (self.kind === 'EXTERNAL' || self.kind === 'VIRTUAL') sheetMsgs.push({ level: 'error', text: `日记账账户须为对公账户、个人卡或现金，「${self.name}」不是` });
      const ent = resolveEntity(entities, sh.header.entity);
      if (self?.entityId && ent && self.entityId !== ent.id) sheetMsgs.push({ level: 'error', text: `表头账户不属于主体「${ent.name}」` });
    }
    if (sh.template === 'PAYROLL') {
      payroll = { entity: resolveEntity(entities, sh.header.entity), month: parseMonth(sh.header.month), payDate: parseDate(sh.header.payDate), payAccount: resolveAccount(accounts, sh.header.payAccount).account };
      if (!payroll.entity) sheetMsgs.push({ level: 'error', text: `表头"公司主体"「${sh.header.entity ?? '空'}」未找到` });
      if (!payroll.month) sheetMsgs.push({ level: 'error', text: '表头"所属月份"格式应为 2026-10' });
      if (!payroll.payDate) sheetMsgs.push({ level: 'error', text: '表头"发放日期"无效' });
      if (!payroll.payAccount || payroll.payAccount.kind !== 'CORPORATE') sheetMsgs.push({ level: 'error', text: `表头"发放账户"「${sh.header.payAccount ?? '空'}」须为对公账户` });
      else if (payroll.entity && payroll.payAccount.entityId !== payroll.entity.id) sheetMsgs.push({ level: 'error', text: '发放账户不属于该主体' });
    }

    for (const r of sh.rows) {
      const v = r.values;
      const key = rowKey(file.name, sh.sheet, r.rowNo);
      const base = { key, file: file.name, sheet: sh.sheet, template: sh.template, rowNo: r.rowNo, rowRef: v.rowRef ? String(v.rowRef) : undefined, raw: v };
      if (skip.has(key)) {
        rows.push({ ...base, status: 'SKIPPED', messages: [{ level: 'info', text: '已选择跳过' }] });
        continue;
      }
      const msgs: RowMessage[] = [...sheetMsgs];
      const err = (field: string, text: string) => msgs.push({ level: 'error', field, text });
      const warn = (field: string, text: string) => msgs.push({ level: 'warning', field, text });
      const row: ImportRow = { ...base, chainNo: v.chainNo ? String(v.chainNo) : undefined, status: 'OK', messages: msgs, selfAccountId: self?.id };
      rows.push(row);
      const str = (k: string) => (v[k] === undefined ? undefined : String(v[k]).trim());
      const req = (k: string, label: string) => {
        const s = str(k);
        if (!s) err(k, `${label}不能为空`);
        return s;
      };

      /** 对方户名 / 收款人：找不到时新建外部往来账户 */
      const pickAccount = (field: string, label: string, name: unknown, allowCreate: boolean) => {
        if (!name) return err(field, `${label}不能为空`), undefined;
        const found = resolveAccount(accounts, name);
        if (found.account) {
          if (found.fuzzy) warn(field, `「${name}」按近似名称识别为「${found.account.name}」，请确认`);
          return found.account;
        }
        if (!allowCreate) return err(field, `${label}「${name}」不存在`), undefined;
        const k = norm(name);
        if (!newCounterparties.has(k)) {
          const acc: Account = { id: tempId('acc'), code: '', name: String(name).trim(), kind: 'EXTERNAL', trace: 'OPTIONAL', status: 'ACTIVE' };
          newCounterparties.set(k, acc);
          accounts.push(acc);
          row.newAccount = acc;
        }
        warn(field, `「${name}」不在账户列表中，导入时将新建为外部往来账户`);
        return newCounterparties.get(k)!;
      };

      // ---------------- 主数据
      if (sh.template === 'ENTITY') {
        const code = req('code', '编号');
        const name = req('name', '全称');
        const shortName = req('shortName', '简称');
        const kind = revLookup(ENTITY_KIND_TEXT, v.kind);
        if (!kind) err('kind', `类型「${v.kind ?? '空'}」无效`);
        const parent = v.parent ? resolveEntity(entities, v.parent) : undefined;
        if (v.parent && !parent) err('parent', `上级主体「${v.parent}」不存在`);
        if (kind === 'BRANCH' && !parent) err('parent', '分公司须填写上级主体');
        const taxpayerType = revLookup(TAXPAYER_TEXT, v.taxpayerType);
        if (!taxpayerType) err('taxpayerType', `纳税人身份「${v.taxpayerType ?? '空'}」无效`);
        const validFrom = parseDate(v.validFrom);
        if (!validFrom) err('validFrom', '身份生效日期无效');
        const vatFiling = v.vatFiling ? revLookup(FILING_TEXT, v.vatFiling) : taxpayerType === 'SMALL' ? 'QUARTER' : 'MONTH';
        if (!vatFiling) err('vatFiling', `增值税申报「${v.vatFiling}」无效`);
        const urbanRate = v.urbanRate ? Number(String(v.urbanRate).replace('%', '')) / (String(v.urbanRate).includes('%') ? 100 : 1) : 0.05;
        if (![0.07, 0.05, 0.01].includes(urbanRate)) err('urbanRate', '城建税率应为 7%、5% 或 1%');
        const halving = v.halving ? v.halving === '是' : taxpayerType === 'SMALL';
        const region = req('region', '所在地');
        if (msgs.some((m) => m.level === 'error')) continue;
        const existing = entities.find((e) => e.code === code);
        const profile: TaxProfile = { taxpayerType: taxpayerType!, vatFiling: vatFiling!, validFrom: validFrom!, urbanRate, halving };
        if (existing) {
          const last = existing.taxProfiles[existing.taxProfiles.length - 1];
          let newProfile: TaxProfile | undefined;
          if (!last || last.taxpayerType !== profile.taxpayerType || last.vatFiling !== profile.vatFiling || last.urbanRate !== urbanRate || last.halving !== halving) {
            if (last && profile.validFrom <= last.validFrom) err('validFrom', `纳税信息有变化，生效日期须晚于现有记录（${last.validFrom}）`);
            newProfile = profile;
            msgs.push({ level: 'info', text: `纳税信息变更：自 ${profile.validFrom} 起为${TAXPAYER_TEXT[profile.taxpayerType]}` });
          }
          const data: Entity = { ...existing, name: name!, shortName: shortName!, kind: kind!, parentId: parent?.id, region: region!, uscc: str('uscc') ?? existing.uscc };
          row.master = { type: 'ENTITY', op: 'UPDATE', id: existing.id, data, newProfile };
          Object.assign(existing, data);
          msgs.push({ level: 'info', text: `编号 ${code} 已存在，将更新` });
        } else {
          if (entities.some((e) => norm(e.name) === norm(name))) err('name', `主体名称「${name}」已被其他编号使用`);
          const data: Entity = { id: tempId('ent'), code: code!, name: name!, shortName: shortName!, kind: kind!, parentId: parent?.id, region: region!, uscc: str('uscc'), taxpayerType: profile.taxpayerType, vatFiling: profile.vatFiling, taxProfiles: [profile], status: 'ACTIVE' };
          const commonProjectId = tempId('prj');
          row.master = { type: 'ENTITY', op: 'CREATE', id: data.id, data, commonProjectId };
          entities.push(data);
          projects.push({ id: commonProjectId, code: `P-${code}-COMMON`, name: `${shortName}·公司公共`, entityId: data.id, kind: 'COMMON', manager: '财务', vatMethod: 'GENERAL', contractAmount: 0, budget: {}, status: 'ACTIVE' });
        }
        continue;
      }

      if (sh.template === 'ACCOUNT') {
        const code = req('code', '编号');
        const name = req('name', '名称');
        const kind = revLookup(ACCOUNT_KIND_TEXT, v.kind);
        if (!kind) err('kind', `类型「${v.kind ?? '空'}」无效，可选：${Object.values(ACCOUNT_KIND_TEXT).join('、')}`);
        const entity = v.entity ? resolveEntity(entities, v.entity) : undefined;
        if (v.entity && !entity) err('entity', `所属主体「${v.entity}」不存在`);
        if (kind === 'CORPORATE' && !entity) err('entity', '对公账户须填写所属主体');
        const holder = str('holder');
        if ((kind === 'INTERNAL_PERSONAL' || kind === 'CASH') && !holder) err('holder', '个人卡、现金账户须填写持有人');
        const last4 = str('last4');
        if (last4 && !/^\d{4}$/.test(last4)) err('last4', '账号尾号应为 4 位数字');
        const opening = parseAmount(v.opening);
        if (opening.bad || opening.negative) err('opening', '期初余额须为非负数，最多两位小数');
        const existing = accounts.find((a) => a.code === code);
        if (msgs.some((m) => m.level === 'error')) continue;
        const trace = kind === 'EXTERNAL' ? 'OPTIONAL' : 'REQUIRED';
        if (existing) {
          if (existing.kind !== kind) err('kind', `已有账户类型为「${ACCOUNT_KIND_TEXT[existing.kind as keyof typeof ACCOUNT_KIND_TEXT] ?? existing.kind}」，不能修改`);
          if ((existing.entityId ?? '') !== (kind === 'CORPORATE' ? entity!.id : '')) err('entity', '所属主体不能修改');
          if (opening.cents) warn('opening', '账户已存在，期初余额不会重复生成');
          const data: Account = { ...existing, name: name!, holder, bank: str('bank'), last4, remark: str('remark') };
          row.master = { type: 'ACCOUNT', op: 'UPDATE', id: existing.id, data };
          Object.assign(existing, data);
          msgs.push({ level: 'info', text: `编号 ${code} 已存在，将更新` });
          continue;
        }
        if (accounts.some((a) => norm(a.name) === norm(name))) err('name', `账户名称「${name}」已存在`);
        const data: Account = { id: tempId('acc'), code: code!, name: name!, kind: kind!, entityId: kind === 'CORPORATE' ? entity!.id : undefined, holder, bank: str('bank'), last4, trace, status: 'ACTIVE', remark: str('remark') };
        row.master = { type: 'ACCOUNT', op: 'CREATE', id: data.id, data };
        accounts.push(data);
        if (opening.cents) {
          const date = v.openingDate ? parseDate(v.openingDate) : todayStr;
          if (!date) err('openingDate', '期初日期无效');
          const openAcc = accounts.find((a) => a.virtualKind === 'OPENING');
          const proj = v.openingProject ? resolveProject(projects, v.openingProject) : projects.find((p) => p.kind === 'COMMON' && p.entityId === entity?.id);
          if (!proj) err('openingProject', entity ? `期初项目「${v.openingProject}」不存在` : '非对公账户有期初余额时须填写"期初项目"');
          const cat = categories.find((c) => c.id === 'c-trf-opening');
          if (date && proj && openAcc && cat) {
            row.flow = { tempId: tempId('flow'), date, amount: opening.cents, fromAccountId: openAcc.id, toAccountId: data.id, method: 'OTHER', bookSummary: '期初余额', splits: [{ projectId: proj.id, categoryId: cat.id, amount: opening.cents }], allocations: [] };
          }
        }
        continue;
      }

      if (sh.template === 'PROJECT') {
        const code = req('code', '编号');
        const name = req('name', '名称');
        const entity = resolveEntity(entities, v.entity);
        if (!entity) err('entity', v.entity ? `承接主体「${v.entity}」不存在` : '承接主体不能为空');
        const manager = req('manager', '负责人');
        const vatMethod = v.vatMethod ? revLookup(VAT_METHOD_TEXT, v.vatMethod) : 'GENERAL';
        if (!vatMethod) err('vatMethod', `计税方式「${v.vatMethod}」无效`);
        const status = v.status ? revLookup(PROJECT_STATUS_TEXT, v.status) : 'ACTIVE';
        if (!status) err('status', `状态「${v.status}」无效`);
        const startDate = v.startDate ? parseDate(v.startDate) : undefined;
        if (v.startDate && !startDate) err('startDate', '开始日期无效');
        const contract = parseAmount(v.contract);
        if (contract.bad || contract.negative) err('contract', '合同额无效');
        const budget: Record<ID, number> = {};
        for (const [k, cat] of Object.entries(BUDGET_KEYS)) {
          const b = parseAmount(v[k]);
          if (b.bad || b.negative) err(k, '预算金额无效');
          else if (b.cents) budget[cat] = b.cents;
        }
        if (msgs.some((m) => m.level === 'error')) continue;
        const existing = projects.find((p) => p.code === code);
        if (existing) {
          if (existing.entityId !== entity!.id) err('entity', '承接主体不能修改');
          const data: Project = { ...existing, name: name!, manager: manager!, customer: str('customer'), region: str('region'), vatMethod: vatMethod!, contractAmount: contract.cents ?? 0, budget, startDate, status: status! };
          row.master = { type: 'PROJECT', op: 'UPDATE', id: existing.id, data };
          Object.assign(existing, data);
          msgs.push({ level: 'info', text: `编号 ${code} 已存在，将更新` });
        } else {
          if (projects.some((p) => norm(p.name) === norm(name))) err('name', `项目名称「${name}」已存在`);
          const data: Project = { id: tempId('prj'), code: code!, name: name!, entityId: entity!.id, kind: 'NORMAL', manager: manager!, customer: str('customer'), region: str('region'), vatMethod: vatMethod!, contractAmount: contract.cents ?? 0, budget, startDate, status: status! };
          row.master = { type: 'PROJECT', op: 'CREATE', id: data.id, data };
          projects.push(data);
        }
        continue;
      }

      // ---------------- 工资表
      if (sh.template === 'PAYROLL') {
        const person = req('person', '人员');
        const amt = (k: string, label: string, required = false) => {
          const a = parseAmount(v[k]);
          if (a.bad || a.negative) err(k, `${label}金额无效`);
          if (required && !a.cents && !a.bad) err(k, `${label}不能为空`);
          return a.cents ?? 0;
        };
        const gross = amt('gross', '应发', true);
        const siPersonal = amt('siPersonal', '社保个人');
        const hfPersonal = amt('hfPersonal', '公积金个人');
        const iit = amt('iit', '个税');
        const otherDeduct = amt('otherDeduct', '其他扣款');
        const net = amt('net', '实发', true);
        const siCompany = amt('siCompany', '社保单位');
        const hfCompany = amt('hfCompany', '公积金单位');
        if (gross && net && Math.abs(gross - siPersonal - hfPersonal - iit - otherDeduct - net) > 1)
          err('net', `应发 ${money(gross)} − 扣款合计 ${money(siPersonal + hfPersonal + iit + otherDeduct)} = ${money(gross - siPersonal - hfPersonal - iit - otherDeduct)}，与实发 ${money(net)} 不一致`);
        // 项目分摊：单项目或"项目:比例;…"
        const parts: { projectId: ID; ratio: number }[] = [];
        if (v.projectSplit) {
          for (const seg of String(v.projectSplit).split(/[;；]/).filter(Boolean)) {
            const [pn, ratio] = seg.split(/[:：]/).map((s) => s.trim());
            const p = resolveProject(projects, pn);
            const r2 = Number(ratio);
            if (!p) err('projectSplit', `分摊项目「${pn}」不存在`);
            else if (!(r2 > 0 && r2 <= 1)) err('projectSplit', `比例「${ratio}」应在 0 到 1 之间`);
            else parts.push({ projectId: p.id, ratio: r2 });
          }
          const sum = parts.reduce((s, x) => s + x.ratio, 0);
          if (parts.length && Math.abs(sum - 1) > 1e-6) err('projectSplit', `分摊比例合计为 ${sum}，应为 1`);
        } else {
          const p = resolveProject(projects, v.project);
          if (!p) err('project', v.project ? `项目「${v.project}」不存在` : '所属项目不能为空');
          else parts.push({ projectId: p.id, ratio: 1 });
        }
        for (const x of parts) {
          const p = projects.find((y) => y.id === x.projectId)!;
          if (p.status === 'CLOSED') err('project', `项目「${p.name}」已结项`);
          if (payroll.entity && p.entityId !== payroll.entity.id && p.kind === 'NORMAL') warn('project', `项目「${p.name}」不属于发放主体`);
        }
        let payee: Account | undefined;
        if (v.payee) payee = pickAccount('payee', '收款账户', v.payee, true);
        else if (person) payee = accounts.find((a) => a.status === 'ACTIVE' && a.kind !== 'VIRTUAL' && (norm(a.name) === norm(person) || (a.kind === 'EXTERNAL' && norm(a.holder) === norm(person)))) ?? pickAccount('person', '收款人', person, true);
        const cat = categories.find((c) => c.id === 'c-wage-base');
        if (msgs.some((m) => m.level === 'error') || !payroll.entity || !payroll.payAccount || !payee || !cat) continue;
        // 按比例拆分实发，尾差计入最后一个项目
        let left = net;
        const splits = parts.map((x, i) => {
          const amount = i === parts.length - 1 ? left : Math.round(net * x.ratio);
          left -= amount;
          return { projectId: x.projectId, categoryId: cat.id, amount };
        });
        row.payroll = {
          batchKey: `${file.name}|${sh.sheet}`, entityId: payroll.entity.id, month: payroll.month!, payDate: payroll.payDate!, payAccountId: payroll.payAccount.id,
          person: person!, idLast4: str('idLast4'), gross, siPersonal, hfPersonal, iit, otherDeduct, net, siCompany, hfCompany, payeeAccountId: payee.id,
        };
        if (net > 0)
          row.flow = {
            tempId: tempId('flow'), date: payroll.payDate!, amount: net, fromAccountId: payroll.payAccount.id, toAccountId: payee.id, method: 'BANK_TRANSFER',
            bookSummary: `${payroll.month} 工资`, actualPurpose: undefined, remark: str('remark'), splits, allocations: [],
          };
        continue;
      }

      // ---------------- 日记账 / 通用流水
      const date = parseDate(v.date);
      if (!date) err('date', `日期「${v.date ?? '空'}」无法识别，请使用日期格式`);
      let from: Account | undefined;
      let to: Account | undefined;
      let amount: number | undefined;

      if (sh.template === 'JOURNAL') {
        const inc = parseAmount(v.income);
        const exp = parseAmount(v.expense);
        if (inc.bad || exp.bad) err('amount', '金额格式错误（须为数字，最多两位小数）');
        if (inc.cents && exp.cents) err('amount', '收入和支出只能填一个');
        if (!inc.cents && !exp.cents && !inc.bad && !exp.bad) err('amount', '收入、支出都为空');
        if (inc.negative || exp.negative) warn('amount', '金额填了负数，已按绝对值处理（模板要求填正数）');
        const counter = pickAccount('counterparty', '对方户名', v.counterparty, true);
        if (self && counter) {
          if (inc.cents) [from, to, amount] = [counter, self, inc.cents];
          else if (exp.cents) [from, to, amount] = [self, counter, exp.cents];
        }
      } else {
        from = pickAccount('from', '转出账户', v.from, false);
        to = pickAccount('to', '转入账户', v.to, true);
        const a = parseAmount(v.amount);
        if (a.bad || !a.cents) err('amount', `金额「${v.amount ?? '空'}」无效`);
        else {
          if (a.negative) warn('amount', '金额填了负数，已按绝对值处理');
          amount = a.cents;
        }
      }
      if (from && to && from.id === to.id) err('to', '转出与转入是同一账户');

      const project = resolveProject(projects, v.project);
      if (!project) err('project', v.project ? `项目「${v.project}」不存在` : '项目不能为空');
      else if (project.status === 'CLOSED') err('project', `项目「${project.name}」已结项，不能再记账`);
      const cat = categoryByPath(v.category);
      if (!cat) err('category', v.category ? `账目类型「${v.category}」不存在，格式为"一级/二级"` : '账目类型不能为空');

      let tax: TaxKind | undefined;
      if (v.tax) {
        tax = revLookup(TAX_KIND, v.tax);
        if (!tax) err('tax', `税种「${v.tax}」无效`);
      }
      if (cat?.requiresTax && !tax) err('tax', `「${v.category}」须填写税种和所属期（缴税不能只记"国库"）`);
      if (tax && !v.taxPeriod) err('taxPeriod', '请填写所属期');
      if (v.taxPeriod && !/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/.test(String(v.taxPeriod))) err('taxPeriod', '所属期格式应为 2026-10 或 2026-Q3');

      let method: FlowMethod = 'BANK_TRANSFER';
      if (v.method) {
        const m = revLookup(FLOW_METHOD, v.method);
        if (!m) err('method', `流转方式「${v.method}」无效`);
        else method = m;
      } else if (from && to) {
        if (to.kind === 'CASH') method = 'CASH_WITHDRAW';
        else if (from.kind === 'CASH') method = 'CASH_HANDOVER';
        else if (from.kind === 'CORPORATE' || to.kind === 'CORPORATE') method = 'CORPORATE_TRANSFER';
      }

      let icNature: IcNature | undefined;
      if (from?.entityId && to?.entityId && from.entityId !== to.entityId) {
        icNature = revLookup(IC_NATURE, v.icNature);
        if (!icNature) {
          icNature = 'FUND_ALLOCATION';
          warn('icNature', '主体之间的往来未填性质，暂按"资金调拨"处理');
        }
      }
      if (project && self?.entityId && project.entityId !== self.entityId && project.kind === 'NORMAL')
        warn('project', `项目属于「${entities.find((e) => e.id === project.entityId)?.shortName}」，与本账户主体不同`);

      const mismatch = !!(v.actualPurpose && v.bookSummary && norm(v.actualPurpose) !== norm(v.bookSummary));
      if (mismatch) msgs.push({ level: 'info', field: 'actualPurpose', text: '账面摘要与实际用途不一致，将标记供内部审计复核' });

      if (date && from && to && amount && project && cat) {
        row.flow = {
          tempId: tempId('flow'), date, amount, fromAccountId: from.id, toAccountId: to.id, method,
          bookSummary: str('bookSummary'), actualPurpose: str('actualPurpose'), purposeMismatch: mismatch, icNature,
          handler: str('handler'), bankSerialNo: str('bankSerialNo'),
          invoiceNos: v.invoiceNos ? String(v.invoiceNos).split(/[;；,，]/).map((s) => s.trim()).filter(Boolean) : undefined,
          remark: str('remark'),
          splits: [{ projectId: project.id, categoryId: cat.id, amount, tax, taxPeriod: str('taxPeriod') }],
          allocations: [],
        };
      }
    }
  }

  // ---------- 行ID 唯一
  const refCount = new Map<string, number>();
  rows.forEach((r) => r.rowRef && refCount.set(r.rowRef, (refCount.get(r.rowRef) ?? 0) + 1));
  rows.forEach((r) => r.rowRef && refCount.get(r.rowRef)! > 1 && r.messages.push({ level: 'error', field: 'rowRef', text: `行ID「${r.rowRef}」重复` }));

  // ---------- 按日期模拟入账：去重 / 对方日记账配对 / 强制溯源 / 期间锁
  simulate(rows, { ...ctx, accounts, projects, entities }, opts.closedPeriods ?? new Set());

  // ---------- 日记账余额核对
  const working = ctx.flows.filter(isLive).concat(rows.filter((r) => r.flow && r.status !== 'DUPLICATE' && r.status !== 'MATCHED' && !r.messages.some((m) => m.level === 'error')).map((r) => r.flow as unknown as Flow));
  for (const r of rows) {
    if (r.raw.checkBalance === undefined || !r.flow || !r.selfAccountId) continue;
    const selfId = r.selfAccountId;
    const bal = working.filter((w) => w.date <= r.flow!.date && (w.fromAccountId === selfId || w.toAccountId === selfId)).reduce((s, w) => s + (w.toAccountId === selfId ? w.amount : -w.amount), 0);
    const expect = Math.round(Number(r.raw.checkBalance) * 100);
    if (expect !== bal) r.messages.push({ level: 'warning', field: 'checkBalance', text: `核对余额 ${money(expect)} 与系统计算 ${money(bal)} 不一致` });
  }

  for (const r of rows) {
    if (r.status === 'DUPLICATE' || r.status === 'MATCHED' || r.status === 'SKIPPED') continue;
    r.status = r.messages.some((m) => m.level === 'error') ? 'ERROR' : r.messages.some((m) => m.level === 'warning') ? 'WARNING' : 'OK';
  }
  // 依赖错误主数据的行（如引用了报错的新账户）在提交时找不到对象：标记为错误
  const failedIds = new Set(rows.filter((r) => r.status === 'ERROR' && r.master).map((r) => r.master!.id));
  for (const r of rows) {
    const f = r.flow;
    if (!f || r.status === 'ERROR') continue;
    if ([f.fromAccountId, f.toAccountId, ...f.splits.map((s) => s.projectId)].some((id) => failedIds.has(id))) {
      r.messages.push({ level: 'error', text: '引用的主体/账户/项目在本批次中校验未通过' });
      r.status = 'ERROR';
    }
  }
  return rows;
}

/** 入账顺序：按日期；同一天里期初（主数据行）在前。提交时必须用同样的顺序，后面的行才能引用前面行的资金 */
export function postingOrder(rows: ImportRow[]) {
  return rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.flow)
    .sort((a, b) => a.r.flow!.date.localeCompare(b.r.flow!.date) || Number(!!b.r.master) - Number(!!a.r.master) || a.i - b.i)
    .map(({ r }) => r);
}

function simulate(rows: ImportRow[], ctx: LedgerData, closedPeriods: Set<string>) {
  const acc = new Map(ctx.accounts.map((a) => [a.id, a]));
  const proj = new Map(ctx.projects.map((p) => [p.id, p]));
  const working: Flow[] = ctx.flows.filter(isLive).map((f) => ({ ...f }));
  const remaining = new Map<ID, number>();
  for (const f of working) if ((acc.get(f.toAccountId)?.trace ?? 'NONE') !== 'NONE') remaining.set(f.id, f.amount);
  for (const f of working) for (const a of f.allocations) remaining.set(a.lotFlowId, (remaining.get(a.lotFlowId) ?? 0) - a.amount);
  const lotInfo = new Map<ID, { account: ID; date: string; projects: ID[]; chainNo?: string; label: string }>();
  for (const f of working) lotInfo.set(f.id, { account: f.toAccountId, date: f.date, projects: f.splits.map((x) => x.projectId), label: f.flowNo });
  const refToTemp = new Map<string, ID>();
  const flowNoToId = new Map(ctx.flows.filter(isLive).map((f) => [f.flowNo, f.id]));

  const order = postingOrder(rows);
  for (const r of order) {
    if (r.messages.some((m) => m.level === 'error')) continue;
    const f = r.flow!;
    const from = acc.get(f.fromAccountId)!;
    const to = acc.get(f.toAccountId)!;

    const ents = new Set([from.entityId, to.entityId, ...f.splits.map((x) => proj.get(x.projectId)?.entityId)].filter(Boolean) as ID[]);
    const closed = [...ents].find((e) => closedPeriods.has(`${e}|${f.date.slice(0, 7)}`));
    if (closed) {
      r.messages.push({ level: 'error', field: 'date', text: `${ctx.entities.find((e) => e.id === closed)?.shortName} ${f.date.slice(0, 7)} 已结账，不能再记账` });
      continue;
    }

    const same = r.template === 'PAYROLL' || r.master ? undefined : working.find((w) => w.fromAccountId === f.fromAccountId && w.toAccountId === f.toAccountId && w.amount === f.amount && Math.abs(Date.parse(w.date) - Date.parse(f.date)) <= 3 * 86400000);
    if (same) {
      const twoSided = (from.kind === 'CORPORATE' || from.trace === 'REQUIRED') && (to.kind === 'CORPORATE' || to.trace === 'REQUIRED');
      r.status = twoSided ? 'MATCHED' : 'DUPLICATE';
      r.messages.push({ level: 'info', text: r.status === 'MATCHED' ? `与已有流水 ${same.flowNo} 是同一笔（对方账户的记录），自动配对，不重复入账` : `与已有流水 ${same.flowNo} 重复（日期/账户/金额相同），默认跳过` });
      continue;
    }

    // 链路号：该账户里已有同链路转入的钱时，只在这些钱里分配；还没有时说明链路从这一行开始，按默认规则分配。
    // 外部账户（可选溯源）只在显式引用来源、或同链路中确有转入该账户的款项时才分配
    const chainLotsHere = !!r.chainNo && [...lotInfo.entries()].some(([id, l]) => l.account === from.id && l.chainNo === r.chainNo && (remaining.get(id) ?? 0) > 0);
    const needTrace = from.trace === 'REQUIRED' || (from.trace === 'OPTIONAL' && (!!r.raw.sourceRef || chainLotsHere));
    if (needTrace) {
      const allocations: Allocation[] = [];
      let fail: string | undefined;
      if (r.raw.sourceRef) {
        for (const part of String(r.raw.sourceRef).split(/[;；]/).filter(Boolean)) {
          const [ref, amt] = part.split(/[:：]/).map((s) => s.trim());
          const lotId = refToTemp.get(ref) ?? flowNoToId.get(ref);
          const cents = Math.round(Number(amt) * 100);
          if (!lotId) { fail = `来源引用「${ref}」不存在或日期晚于本行`; break; }
          if (lotInfo.get(lotId)?.account !== from.id) { fail = `来源「${ref}」不是转入「${from.name}」的款项`; break; }
          if (!(cents > 0)) { fail = `来源引用「${part}」金额无效`; break; }
          const left = remaining.get(lotId) ?? 0;
          if (left < cents) { fail = `来源「${ref}」剩余 ${money(left)}，不足 ${money(cents)}`; break; }
          allocations.push({ lotFlowId: lotId, amount: cents, auto: false });
        }
        const sum = allocations.reduce((s, a) => s + a.amount, 0);
        if (!fail && sum !== f.amount) fail = `来源引用合计 ${money(sum)} 与金额 ${money(f.amount)} 不一致`;
      } else {
        const sameProject = (id: ID) => Number(lotInfo.get(id)!.projects.includes(f.splits[0].projectId));
        const candidates = [...remaining.entries()]
          .filter(([id, left]) => left > 0 && lotInfo.get(id)?.account === from.id && lotInfo.get(id)!.date <= f.date && (!chainLotsHere || lotInfo.get(id)?.chainNo === r.chainNo))
          .sort((a, b) => sameProject(b[0]) - sameProject(a[0]) || lotInfo.get(a[0])!.date.localeCompare(lotInfo.get(b[0])!.date));
        let need = f.amount;
        for (const [id, left] of candidates) {
          if (need <= 0) break;
          const take = Math.min(left, need);
          allocations.push({ lotFlowId: id, amount: take, auto: true });
          need -= take;
        }
        if (need > 0) {
          const avail = f.amount - need;
          fail = chainLotsHere
            ? `链路 ${r.chainNo} 中「${from.name}」可用资金 ${money(avail)}，不足 ${money(f.amount)}`
            : `「${from.name}」截至 ${f.date} 可用资金 ${money(avail)}，不足 ${money(f.amount)}。每笔出款都必须有资金来源，请先导入或录入这笔钱的来源`;
        }
      }
      if (fail && from.trace === 'REQUIRED') {
        r.messages.push({ level: 'error', field: 'sourceRef', text: fail });
        continue;
      }
      if (fail) r.messages.push({ level: 'warning', field: 'sourceRef', text: `${fail}（外部账户可不溯源，已忽略）` });
      else {
        f.allocations = allocations;
        r.messages.push({ level: 'info', text: `资金来源：${allocations.map((a) => `${lotInfo.get(a.lotFlowId)!.label} ${money(a.amount)}`).join('；')}${allocations.every((a) => a.auto) ? (chainLotsHere ? `（链路 ${r.chainNo} 内先进先出）` : '（同项目优先、先进先出）') : '（按指定）'}` });
        for (const a of allocations) remaining.set(a.lotFlowId, remaining.get(a.lotFlowId)! - a.amount);
      }
    }

    working.push({ ...(f as unknown as Flow), id: f.tempId, flowNo: r.rowRef ?? `第${r.rowNo}行`, status: 'CONFIRMED' });
    if (to.trace !== 'NONE') remaining.set(f.tempId, f.amount);
    lotInfo.set(f.tempId, { account: to.id, date: f.date, projects: f.splits.map((x) => x.projectId), chainNo: r.chainNo, label: r.rowRef ? `行${r.rowRef}` : `${r.sheet}第${r.rowNo}行` });
    if (r.rowRef) refToTemp.set(r.rowRef, f.tempId);
  }
}
