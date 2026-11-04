// Excel 模板生成、解析与导出（ExcelJS，浏览器与 Node 通用）。
// 模板规范见 docs/需求方案.md §4.7.1：金额填正数、日期用日期单元格、无公式/合计行/合并单元格。
// 本文件只构建 Workbook；下载（浏览器）或写入响应（服务端）由调用方负责。
import ExcelJS from 'exceljs';
import { ACCOUNT_KIND, FLOW_METHOD, FLOW_STATUS, IC_NATURE, TAX_KIND } from './labels';
import type { Account, Category, Flow, LedgerData } from './types';
import type { Trace } from './selectors';

export const TEMPLATE_VERSION = 1;
export type TemplateCode = 'JOURNAL' | 'FLOW' | 'PAYROLL' | 'ENTITY' | 'ACCOUNT' | 'PROJECT';

export const TEMPLATE_NAMES: Record<TemplateCode, string> = {
  JOURNAL: '账户日记账',
  FLOW: '通用资金流水',
  PAYROLL: '工资表',
  ENTITY: '公司主体',
  ACCOUNT: '账户',
  PROJECT: '项目',
};

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1677FF' } };
const HINT_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
const MONEY_FMT = '#,##0.00';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const categoryPath = (categories: Category[], id: string) => {
  const c = categories.find((x) => x.id === id);
  const p = c?.parentId ? categories.find((x) => x.id === c.parentId) : undefined;
  return p ? `${p.name}/${c!.name}` : (c?.name ?? '');
};
export const leafCategoryPaths = (categories: Category[]) => categories.filter((c) => c.parentId).map((c) => categoryPath(categories, c.id));

// 下拉选项文字（导入时反查）
export const ENTITY_KIND_TEXT = { INDEPENDENT: '独立公司', HEAD: '总公司', BRANCH: '分公司' } as const;
export const TAXPAYER_TEXT = { GENERAL: '一般纳税人', SMALL: '小规模纳税人' } as const;
export const FILING_TEXT = { MONTH: '按月', QUARTER: '按季' } as const;
export const VAT_METHOD_TEXT = { GENERAL: '一般计税', SIMPLE: '简易计税' } as const;
export const PROJECT_STATUS_TEXT = { PREPARING: '筹备', ACTIVE: '进行中', CLOSED: '已结项' } as const;
export const ACCOUNT_KIND_TEXT = { CORPORATE: '对公账户', INTERNAL_PERSONAL: '内部个人', CASH: '现金', EXTERNAL: '外部往来' } as const;

type Dict = Record<string, string>;

/** 隐藏字典页：下拉选项来源 + 模板标识（导入时据此识别模板与版本） */
function addDictSheet(wb: ExcelJS.Workbook, code: TemplateCode, ctx: LedgerData): Dict {
  const ws = wb.addWorksheet('_dict', { state: 'veryHidden' });
  ws.getCell('A1').value = `TPL=${code};V=${TEMPLATE_VERSION}`;
  const lists: Record<string, string[]> = {
    B: ctx.accounts.filter((a) => a.status === 'ACTIVE').map((a) => a.name),
    C: ctx.projects.filter((p) => p.status !== 'CLOSED').map((p) => p.name),
    D: leafCategoryPaths(ctx.categories),
    E: Object.values(FLOW_METHOD),
    F: Object.values(TAX_KIND),
    G: ctx.entities.map((e) => e.name),
    H: Object.values(IC_NATURE),
    I: Object.values(ENTITY_KIND_TEXT),
    J: Object.values(TAXPAYER_TEXT),
    K: Object.values(FILING_TEXT),
    L: Object.values(VAT_METHOD_TEXT),
    M: Object.values(PROJECT_STATUS_TEXT),
    N: Object.values(ACCOUNT_KIND_TEXT),
    O: ['是', '否'],
    P: ['7%', '5%', '1%'],
    Q: ctx.accounts.filter((a) => a.status === 'ACTIVE' && a.kind === 'CORPORATE').map((a) => a.name),
  };
  for (const [col, values] of Object.entries(lists)) values.forEach((v, i) => (ws.getCell(`${col}${i + 2}`).value = v));
  const ref = (col: string) => `_dict!$${col}$2:$${col}$${Math.max(2, lists[col].length + 1)}`;
  return {
    account: ref('B'), project: ref('C'), category: ref('D'), method: ref('E'), tax: ref('F'), entity: ref('G'), ic: ref('H'),
    entityKind: ref('I'), taxpayer: ref('J'), filing: ref('K'), vatMethod: ref('L'), projectStatus: ref('M'), accountKind: ref('N'),
    yesNo: ref('O'), urbanRate: ref('P'), corporate: ref('Q'),
  };
}

export interface ColDef {
  header: string;
  key: string;
  width: number;
  required?: boolean;
  hint: string;
  list?: keyof ReturnType<typeof addDictSheet> | string;
  kind?: 'date' | 'money';
}

interface HeaderField {
  label: string;
  key: string;
  cell: string; // 值所在单元格
  list?: string;
  kind?: 'date' | 'month';
}

interface TemplateSpec {
  title: string;
  sheet: string;
  headerRow: number;
  headerFields: HeaderField[];
  columns: ColDef[];
  instructions: string[];
}

const TRACE_RULES = [
  '对公账户、个人卡、现金账户的每笔出款都必须有资金来源：',
  '   · 不填"链路号"和"来源引用"时，系统自动分配：同项目的入款优先，再按先进先出；',
  '   · 填写"链路号"时，只在同一链路号转入该账户的钱中分配（链路的第一行按默认规则分配），适合迁移历史资金链；',
  '   · 填写"来源引用"时按指定分配，格式：行ID:金额;行ID:金额，也可引用系统已有流水号。',
];

const COMMON_RULES = [
  '带 * 的列必填；下拉列来自系统当前数据，模板下载后新增的数据需重新下载模板。',
  '金额一律填正数，最多两位小数；日期请使用日期格式（如 2026-11-02），不要写成文本。',
  '不要使用公式、合计行、合并单元格；余额与合计由系统计算。',
];

export const TEMPLATES: Record<TemplateCode, TemplateSpec> = {
  JOURNAL: {
    title: '账户日记账导入模板（每个 Sheet 对应一个账户，可复制 Sheet 填写多个账户）',
    sheet: '日记账',
    headerRow: 5,
    headerFields: [
      { label: '公司主体*', key: 'entity', cell: 'B2', list: 'entity' },
      { label: '账户*', key: 'account', cell: 'E2', list: 'account' },
    ],
    columns: [
      { header: '行ID', key: 'rowRef', width: 8, hint: '可选，供其他行"来源引用"使用' },
      { header: '交易日期', key: 'date', width: 12, required: true, kind: 'date', hint: '日期格式' },
      { header: '对方户名', key: 'counterparty', width: 28, required: true, list: 'account', hint: '下拉选择；外部单位可直接输入名称' },
      { header: '账面摘要', key: 'bookSummary', width: 26, hint: '银行回单上的用途' },
      { header: '收入', key: 'income', width: 14, kind: 'money', hint: '正数；与支出二选一' },
      { header: '支出', key: 'expense', width: 14, kind: 'money', hint: '正数，不要写负号' },
      { header: '项目', key: 'project', width: 30, required: true, list: 'project', hint: '下拉选择' },
      { header: '账目类型', key: 'category', width: 20, required: true, list: 'category', hint: '一级/二级' },
      { header: '实际用途', key: 'actualPurpose', width: 24, hint: '与账面摘要不一致时必填' },
      { header: '税种', key: 'tax', width: 10, list: 'tax', hint: '对方为国库/社保时必填' },
      { header: '所属期', key: 'taxPeriod', width: 10, hint: '如 2026-10 / 2026-Q3' },
      { header: '往来性质', key: 'icNature', width: 10, list: 'ic', hint: '对方为平台内其他主体时填写' },
      { header: '链路号', key: 'chainNo', width: 10, hint: '同一笔钱的流转填相同编号，如 L001' },
      { header: '来源引用', key: 'sourceRef', width: 18, hint: '可选，行ID:金额;…' },
      { header: '发票号', key: 'invoiceNos', width: 22, hint: '多个用 ; 分隔' },
      { header: '银行流水号', key: 'bankSerialNo', width: 18, hint: '用于去重' },
      { header: '余额（核对）', key: 'checkBalance', width: 14, kind: 'money', hint: '可选；系统逐行核对' },
      { header: '备注', key: 'remark', width: 24, hint: '不要合并单元格' },
    ],
    instructions: [
      ...COMMON_RULES,
      ...TRACE_RULES,
      '账面摘要与实际用途不一致时（如银行写"工资"实际为房租），请填写实际用途，账目类型按实际用途选择。',
      '对方为平台内其他主体的对公账户时，只需在任意一方的日记账中出现；两边都填写时系统自动配对，不会重复入账。',
      '导入后立即生效；如有问题可在系统中整批撤销后重新导入。',
    ],
  },
  FLOW: {
    title: '',
    sheet: '资金流水',
    headerRow: 1,
    headerFields: [],
    columns: [
      { header: '行ID', key: 'rowRef', width: 8, hint: '可选，供"来源引用"使用' },
      { header: '日期', key: 'date', width: 12, required: true, kind: 'date', hint: '日期格式' },
      { header: '转出账户', key: 'from', width: 24, required: true, list: 'account', hint: '下拉选择' },
      { header: '转入账户', key: 'to', width: 24, required: true, list: 'account', hint: '下拉选择' },
      { header: '金额', key: 'amount', width: 14, required: true, kind: 'money', hint: '正数，两位小数' },
      { header: '流转方式', key: 'method', width: 12, required: true, list: 'method', hint: '下拉选择' },
      { header: '项目', key: 'project', width: 30, required: true, list: 'project', hint: '下拉选择' },
      { header: '账目类型', key: 'category', width: 20, required: true, list: 'category', hint: '一级/二级' },
      { header: '账面摘要', key: 'bookSummary', width: 22, hint: '' },
      { header: '实际用途', key: 'actualPurpose', width: 22, hint: '与摘要不一致时必填' },
      { header: '税种', key: 'tax', width: 10, list: 'tax', hint: '缴税时必填' },
      { header: '所属期', key: 'taxPeriod', width: 10, hint: '2026-10 / 2026-Q3' },
      { header: '往来性质', key: 'icNature', width: 10, list: 'ic', hint: '主体之间往来时填写' },
      { header: '经办人', key: 'handler', width: 10, hint: '' },
      { header: '链路号', key: 'chainNo', width: 10, hint: '同一笔钱的流转填相同编号' },
      { header: '来源引用', key: 'sourceRef', width: 18, hint: '行ID:金额;… 或 流水号:金额' },
      { header: '发票号', key: 'invoiceNos', width: 20, hint: '多个用 ; 分隔' },
      { header: '银行流水号', key: 'bankSerialNo', width: 16, hint: '' },
      { header: '备注', key: 'remark', width: 20, hint: '' },
    ],
    instructions: [...COMMON_RULES, ...TRACE_RULES, '导入后立即生效；如有问题可在系统中整批撤销后重新导入。'],
  },
  PAYROLL: {
    title: '工资表导入模板（个税、社保为外部已结算结果，系统只校验与记账）',
    sheet: '工资表',
    headerRow: 5,
    headerFields: [
      { label: '公司主体*', key: 'entity', cell: 'B2', list: 'entity' },
      { label: '所属月份*', key: 'month', cell: 'E2', kind: 'month' },
      { label: '发放账户*', key: 'payAccount', cell: 'B3', list: 'corporate' },
      { label: '发放日期*', key: 'payDate', cell: 'E3', kind: 'date' },
    ],
    columns: [
      { header: '人员', key: 'person', width: 12, required: true, hint: '姓名' },
      { header: '身份证后四位', key: 'idLast4', width: 12, hint: '同名时用于区分' },
      { header: '所属项目', key: 'project', width: 30, required: true, list: 'project', hint: '多个项目时填"项目分摊"' },
      { header: '项目分摊', key: 'projectSplit', width: 26, hint: '可选：项目名:比例;… 比例合计 = 1' },
      { header: '应发', key: 'gross', width: 12, required: true, kind: 'money', hint: '' },
      { header: '社保个人', key: 'siPersonal', width: 12, kind: 'money', hint: '' },
      { header: '公积金个人', key: 'hfPersonal', width: 12, kind: 'money', hint: '' },
      { header: '个税', key: 'iit', width: 12, kind: 'money', hint: '外部已算好的结果' },
      { header: '其他扣款', key: 'otherDeduct', width: 12, kind: 'money', hint: '' },
      { header: '实发', key: 'net', width: 12, required: true, kind: 'money', hint: '应发 − 各项扣款' },
      { header: '社保单位', key: 'siCompany', width: 12, kind: 'money', hint: '' },
      { header: '公积金单位', key: 'hfCompany', width: 12, kind: 'money', hint: '' },
      { header: '收款账户', key: 'payee', width: 20, list: 'account', hint: '可选；默认按人员姓名建外部账户' },
      { header: '备注', key: 'remark', width: 20, hint: '' },
    ],
    instructions: [
      ...COMMON_RULES,
      '每行校验：应发 − 社保个人 − 公积金个人 − 个税 − 其他扣款 = 实发（允许 0.01 尾差），不平的行不会导入。',
      '每个人生成一笔"发放账户 → 收款账户"的实发流水，账目类型为"人员工资/基本工资"，资金来源按默认规则自动分配。',
      '个税、社保由后续缴税流水支付（对方为国库/社保，须填税种与所属期），工资表中的金额用于汇总与核对。',
      '同一主体同一月份再次导入视为补发，生成新的工资批次。',
    ],
  },
  ENTITY: {
    title: '',
    sheet: '公司主体',
    headerRow: 1,
    headerFields: [],
    columns: [
      { header: '编号', key: 'code', width: 10, required: true, hint: '唯一；已存在则更新' },
      { header: '全称', key: 'name', width: 34, required: true, hint: '' },
      { header: '简称', key: 'shortName', width: 12, required: true, hint: '' },
      { header: '类型', key: 'kind', width: 10, required: true, list: 'entityKind', hint: '' },
      { header: '上级主体', key: 'parent', width: 30, list: 'entity', hint: '分公司必填' },
      { header: '纳税人身份', key: 'taxpayerType', width: 14, required: true, list: 'taxpayer', hint: '' },
      { header: '身份生效日期', key: 'validFrom', width: 14, required: true, kind: 'date', hint: '身份变更时填新日期' },
      { header: '增值税申报', key: 'vatFiling', width: 10, list: 'filing', hint: '默认：一般按月、小规模按季' },
      { header: '城建税率', key: 'urbanRate', width: 10, list: 'urbanRate', hint: '默认 5%' },
      { header: '六税两费减半', key: 'halving', width: 12, list: 'yesNo', hint: '默认：小规模是' },
      { header: '所在地', key: 'region', width: 14, required: true, hint: '' },
      { header: '统一社会信用代码', key: 'uscc', width: 22, hint: '' },
    ],
    instructions: [...COMMON_RULES, '按"编号"匹配：编号已存在时更新该主体；纳税人身份或生效日期变化时新增一条身份记录。', '新主体会自动生成"公司公共"项目。'],
  },
  ACCOUNT: {
    title: '',
    sheet: '账户',
    headerRow: 1,
    headerFields: [],
    columns: [
      { header: '编号', key: 'code', width: 12, required: true, hint: '唯一；已存在则更新' },
      { header: '名称', key: 'name', width: 26, required: true, hint: '如：擎宇-农行基本户、王xx-建行卡' },
      { header: '类型', key: 'kind', width: 10, required: true, list: 'accountKind', hint: '' },
      { header: '所属主体', key: 'entity', width: 30, list: 'entity', hint: '对公账户必填' },
      { header: '持有人', key: 'holder', width: 10, hint: '个人卡、现金必填' },
      { header: '开户行', key: 'bank', width: 14, hint: '' },
      { header: '账号尾号', key: 'last4', width: 10, hint: '4 位' },
      { header: '期初余额', key: 'opening', width: 14, kind: 'money', hint: '仅新建时生效' },
      { header: '期初日期', key: 'openingDate', width: 12, kind: 'date', hint: '默认今天' },
      { header: '期初项目', key: 'openingProject', width: 26, list: 'project', hint: '默认所属主体"公司公共"' },
      { header: '备注', key: 'remark', width: 20, hint: '' },
    ],
    instructions: [...COMMON_RULES, '按"编号"匹配：已存在则更新名称、持有人、开户行等信息；类型与所属主体不可修改。', '期初余额生成一笔"期初 → 账户"的流水，作为后续出款的资金来源。'],
  },
  PROJECT: {
    title: '',
    sheet: '项目',
    headerRow: 1,
    headerFields: [],
    columns: [
      { header: '编号', key: 'code', width: 14, required: true, hint: '唯一；已存在则更新' },
      { header: '名称', key: 'name', width: 34, required: true, hint: '' },
      { header: '承接主体', key: 'entity', width: 30, required: true, list: 'entity', hint: '' },
      { header: '负责人', key: 'manager', width: 10, required: true, hint: '' },
      { header: '客户', key: 'customer', width: 26, hint: '' },
      { header: '所在地', key: 'region', width: 12, hint: '' },
      { header: '计税方式', key: 'vatMethod', width: 10, list: 'vatMethod', hint: '默认一般计税' },
      { header: '合同额', key: 'contract', width: 14, kind: 'money', hint: '' },
      { header: '材料预算', key: 'bMat', width: 12, kind: 'money', hint: '' },
      { header: '人工预算', key: 'bWage', width: 12, kind: 'money', hint: '' },
      { header: '报销预算', key: 'bReimb', width: 12, kind: 'money', hint: '' },
      { header: '分包预算', key: 'bSub', width: 12, kind: 'money', hint: '' },
      { header: '开始日期', key: 'startDate', width: 12, kind: 'date', hint: '' },
      { header: '状态', key: 'status', width: 10, list: 'projectStatus', hint: '默认进行中' },
    ],
    instructions: [...COMMON_RULES, '按"编号"匹配：已存在则更新；承接主体不可修改。已结项项目不能再记账。'],
  },
};

export const BUDGET_KEYS: Record<string, string> = { bMat: 'c-mat', bWage: 'c-wage', bReimb: 'c-reimb', bSub: 'c-sub' };

function writeHeader(ws: ExcelJS.Worksheet, cols: ColDef[], headerRow: number) {
  cols.forEach((c, i) => {
    const h = ws.getCell(headerRow, i + 1);
    h.value = c.required ? `${c.header}*` : c.header;
    h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h.fill = HEADER_FILL;
    h.alignment = { vertical: 'middle', horizontal: 'center' };
    const hint = ws.getCell(headerRow + 1, i + 1);
    hint.value = c.hint;
    hint.font = { italic: true, color: { argb: 'FF8C8C8C' }, size: 9 };
    hint.fill = HINT_FILL;
    hint.alignment = { wrapText: true, vertical: 'top' };
    ws.getColumn(i + 1).width = c.width;
  });
  ws.getRow(headerRow + 1).height = 42;
  ws.views = [{ state: 'frozen', ySplit: headerRow + 1 }];
}

function addValidations(ws: ExcelJS.Worksheet, cols: ColDef[], dict: Dict, firstRow: number, lastRow: number) {
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1).letter;
    for (let r = firstRow; r <= lastRow; r++) {
      const cell = ws.getCell(`${col}${r}`);
      if (c.list) cell.dataValidation = { type: 'list', allowBlank: !c.required, formulae: [dict[c.list]], showErrorMessage: false };
      if (c.kind === 'date') {
        cell.numFmt = 'yyyy-mm-dd';
        cell.dataValidation = { type: 'date', operator: 'greaterThan', allowBlank: !c.required, formulae: [new Date('2000-01-01')], showErrorMessage: true, error: '请输入日期，如 2026-11-02' };
      }
      if (c.kind === 'money') cell.numFmt = MONEY_FMT;
    }
  });
}

export type CellInput = string | number | Date | null;

/** 生成模板。header：表头区取值（如日记账的主体、账户）；rows：预填的数据行（示例或回填现有数据） */
export function buildTemplate(code: TemplateCode, ctx: LedgerData, opts: { header?: Record<string, CellInput>; rows?: CellInput[][] } = {}) {
  const spec = TEMPLATES[code];
  const wb = new ExcelJS.Workbook();
  wb.creator = '内部账目管理平台';
  const ws = wb.addWorksheet(spec.sheet);
  const dict = addDictSheet(wb, code, ctx);
  if (spec.title) {
    ws.mergeCells('A1:F1');
    ws.getCell('A1').value = spec.title;
    ws.getCell('A1').font = { bold: true, size: 13 };
  }
  for (const f of spec.headerFields) {
    const labelCell = ws.getCell(f.cell).address.replace(/^[A-Z]+/, (c) => String.fromCharCode(c.charCodeAt(0) - 1));
    ws.getCell(labelCell).value = f.label;
    ws.getCell(labelCell).font = { bold: true };
    const v = ws.getCell(f.cell);
    v.value = opts.header?.[f.key] ?? null;
    if (f.list) v.dataValidation = { type: 'list', allowBlank: false, formulae: [dict[f.list]] };
    if (f.kind === 'date') v.numFmt = 'yyyy-mm-dd';
    if (f.kind === 'month') v.note = '格式：2026-10';
  }
  writeHeader(ws, spec.columns, spec.headerRow);
  const first = spec.headerRow + 2;
  (opts.rows ?? []).forEach((r, i) => (ws.getRow(first + i).values = r));
  addValidations(ws, spec.columns, dict, first, first + Math.max(500, (opts.rows ?? []).length + 100));
  const help = wb.addWorksheet('填写说明');
  help.getCell('A1').value = `${TEMPLATE_NAMES[code]}模板 填写说明`;
  help.getCell('A1').font = { bold: true, size: 13 };
  spec.instructions.forEach((l, i) => (help.getCell(`A${i + 3}`).value = l.startsWith(' ') ? l : `${i + 1}. ${l}`));
  help.getColumn(1).width = 110;
  return wb;
}

// ---------------------------------------------------------------- 解析

export interface ParsedSheet {
  sheet: string;
  template: TemplateCode;
  header: Record<string, unknown>;
  rows: { rowNo: number; values: Record<string, unknown> }[];
}

const cellValue = (v: ExcelJS.CellValue): unknown => {
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v;
    if ('result' in v) return (v as ExcelJS.CellFormulaValue).result;
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return (v as ExcelJS.CellHyperlinkValue).text;
  }
  return v;
};

const headerKeys = (ws: ExcelJS.Worksheet, spec: TemplateSpec) => {
  const keyByCol = new Map<number, string>();
  ws.getRow(spec.headerRow).eachCell((c, col) => {
    const h = String(cellValue(c.value) ?? '').replace('*', '').trim();
    const def = spec.columns.find((d) => d.header === h);
    if (def) keyByCol.set(col, def.key);
  });
  return keyByCol;
};

/** 没有模板标识时（用户另存为、复制到新文件）按表头识别：必填列全部出现即认为匹配 */
function detect(ws: ExcelJS.Worksheet): TemplateCode | undefined {
  return (Object.keys(TEMPLATES) as TemplateCode[]).find((code) => {
    const spec = TEMPLATES[code];
    const keys = new Set(headerKeys(ws, spec).values());
    return spec.columns.filter((c) => c.required).every((c) => keys.has(c.key)) && keys.size >= spec.columns.filter((c) => c.required).length + 1;
  });
}

export async function parseWorkbook(data: ArrayBuffer | Uint8Array): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as ArrayBuffer);
  const tag = String(wb.getWorksheet('_dict')?.getCell('A1').value ?? '');
  const m = /TPL=(\w+);V=(\d+)/.exec(tag);
  const tagged = m && m[1] in TEMPLATES ? (m[1] as TemplateCode) : undefined;
  const out: ParsedSheet[] = [];
  wb.eachSheet((ws) => {
    if (ws.name === '_dict' || ws.name === '填写说明') return;
    const template = tagged ?? detect(ws);
    if (!template) return;
    const spec = TEMPLATES[template];
    const keyByCol = headerKeys(ws, spec);
    const header: Record<string, unknown> = {};
    for (const f of spec.headerFields) {
      const v = cellValue(ws.getCell(f.cell).value);
      header[f.key] = typeof v === 'string' ? v.trim() : v;
    }
    const rows: ParsedSheet['rows'] = [];
    ws.eachRow((row, rowNo) => {
      if (rowNo <= spec.headerRow + 1) return;
      const values: Record<string, unknown> = {};
      let any = false;
      keyByCol.forEach((key, col) => {
        const v = cellValue(row.getCell(col).value);
        if (v !== null && v !== undefined && String(v).trim() !== '') {
          values[key] = typeof v === 'string' ? v.trim() : v;
          any = true;
        }
      });
      if (any) rows.push({ rowNo, values });
    });
    out.push({ sheet: ws.name, template, header, rows });
  });
  if (!out.length) throw new Error('未识别到平台模板。请使用"下载模板"获取的文件填写，不要修改表头。');
  return out;
}

// ---------------------------------------------------------------- 导出

export interface ExportMeta {
  scopeLabel: string;
  exporter: string;
  exportedAt: string;
}

function watermark(ws: ExcelJS.Worksheet, title: string, span: number, meta: ExportMeta) {
  ws.mergeCells(1, 1, 1, span);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { bold: true, size: 13 };
  ws.mergeCells(2, 1, 2, span);
  ws.getCell(2, 1).value = `数据范围：${meta.scopeLabel}　导出人：${meta.exporter}　导出时间：${meta.exportedAt}　本文件为内部资料，请勿外传`;
  ws.getCell(2, 1).font = { color: { argb: 'FF8C8C8C' }, size: 9 };
}

export interface TableHeader {
  header: string;
  width: number;
  money?: boolean;
  date?: boolean;
}

function table(ws: ExcelJS.Worksheet, startRow: number, headers: TableHeader[], rows: unknown[][]) {
  headers.forEach((h, i) => {
    const c = ws.getCell(startRow, i + 1);
    c.value = h.header;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = HEADER_FILL;
    ws.getColumn(i + 1).width = h.width;
  });
  rows.forEach((r, ri) => {
    const row = ws.getRow(startRow + 1 + ri);
    row.values = r as ExcelJS.CellValue[];
    headers.forEach((h, i) => {
      if (h.money) row.getCell(i + 1).numFmt = MONEY_FMT;
      if (h.date) row.getCell(i + 1).numFmt = 'yyyy-mm-dd';
    });
  });
  ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: startRow + Math.max(rows.length, 1), column: headers.length } };
  ws.views = [{ state: 'frozen', ySplit: startRow }];
}

const yuan = (cents: number) => Math.round(cents) / 100;
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

export function buildFlowsExport(flows: Flow[], ctx: LedgerData, title: string, meta: ExportMeta) {
  const acc = new Map(ctx.accounts.map((a) => [a.id, a]));
  const proj = new Map(ctx.projects.map((p) => [p.id, p]));
  const flowNo = new Map(ctx.flows.map((f) => [f.id, f.flowNo]));
  const ent = (id?: string) => ctx.entities.find((e) => e.id === id)?.shortName ?? '';
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('流水明细');
  const headers: TableHeader[] = [
    { header: '流水号', width: 16 }, { header: '日期', width: 12, date: true }, { header: '转出账户', width: 24 }, { header: '转出主体', width: 12 },
    { header: '转入账户', width: 24 }, { header: '转入主体', width: 12 }, { header: '金额', width: 14, money: true }, { header: '方式', width: 10 },
    { header: '项目', width: 30 }, { header: '项目主体', width: 12 }, { header: '账目类型', width: 18 }, { header: '分摊金额', width: 14, money: true },
    { header: '账面摘要', width: 24 }, { header: '实际用途', width: 24 }, { header: '用途不一致', width: 10 }, { header: '集团内往来', width: 10 },
    { header: '税种/所属期', width: 14 }, { header: '资金来源（流水号:金额）', width: 30 }, { header: '发票号', width: 22 }, { header: '状态', width: 8 },
    { header: '导入批次', width: 20 }, { header: '备注', width: 24 },
  ];
  const rows: unknown[][] = [];
  // 一笔多分摊时展开为多行，金额列只在首行出现，避免透视求和重复
  for (const f of [...flows].sort((a, b) => a.date.localeCompare(b.date) || a.flowNo.localeCompare(b.flowNo))) {
    f.splits.forEach((s, i) => {
      const p = proj.get(s.projectId);
      rows.push([
        f.flowNo, asDate(f.date), acc.get(f.fromAccountId)?.name, ent(acc.get(f.fromAccountId)?.entityId), acc.get(f.toAccountId)?.name,
        ent(acc.get(f.toAccountId)?.entityId), i === 0 ? yuan(f.amount) : null, FLOW_METHOD[f.method], p?.name, ent(p?.entityId), categoryPath(ctx.categories, s.categoryId),
        yuan(s.amount), f.bookSummary ?? '', f.actualPurpose ?? '', f.purposeMismatch ? '是' : '', f.icNature ? IC_NATURE[f.icNature] : '',
        s.tax ? `${TAX_KIND[s.tax]} ${s.taxPeriod ?? ''}` : '',
        f.allocations.map((a) => `${flowNo.get(a.lotFlowId)}:${yuan(a.amount)}`).join(';'),
        (f.invoiceNos ?? []).join(';'), FLOW_STATUS[f.status].label, f.importBatchNo ?? '', f.remark ?? '',
      ]);
    });
  }
  watermark(ws, title, headers.length, meta);
  table(ws, 4, headers, rows);
  return wb;
}

/** 账户日记账：沿用财务熟悉的版式，但余额与合计由系统计算 */
export function buildJournalExport(account: Account, ctx: LedgerData, meta: ExportMeta, range: { from?: string; to?: string } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(account.name.replace(/[\\/?*[\]:]/g, '').slice(0, 30));
  const acc = new Map(ctx.accounts.map((a) => [a.id, a]));
  const mine = ctx.flows
    .filter((f) => f.status === 'CONFIRMED' && (f.fromAccountId === account.id || f.toAccountId === account.id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.flowNo.localeCompare(b.flowNo));
  let bal = 0;
  for (const f of mine) if (range.from && f.date < range.from) bal += f.toAccountId === account.id ? f.amount : -f.amount;
  const rows: unknown[][] = [[null, range.from ? asDate(range.from) : null, null, '期初余额', null, null, yuan(bal), null, null, null]];
  let inc = 0;
  let exp = 0;
  let n = 0;
  for (const f of mine) {
    if ((range.from && f.date < range.from) || (range.to && f.date > range.to)) continue;
    const isIn = f.toAccountId === account.id;
    bal += isIn ? f.amount : -f.amount;
    if (isIn) inc += f.amount;
    else exp += f.amount;
    rows.push([++n, asDate(f.date), acc.get(isIn ? f.fromAccountId : f.toAccountId)?.name, f.bookSummary ?? f.actualPurpose ?? '', isIn ? yuan(f.amount) : null, isIn ? null : yuan(f.amount), yuan(bal), categoryPath(ctx.categories, f.splits[0].categoryId), f.flowNo, f.remark ?? '']);
  }
  rows.push(['合计', null, null, null, yuan(inc), yuan(exp), yuan(bal), null, null, null]);
  watermark(ws, `${account.name} 银行日记账${range.from || range.to ? `（${range.from ?? ''} 至 ${range.to ?? ''}）` : ''}`, 10, meta);
  table(
    ws,
    4,
    [
      { header: '序号', width: 6 }, { header: '交易日期', width: 12, date: true }, { header: '对方户名', width: 30 }, { header: '摘要', width: 30 },
      { header: '收入', width: 14, money: true }, { header: '支出', width: 14, money: true }, { header: '余额', width: 14, money: true },
      { header: '账目类型', width: 18 }, { header: '流水号', width: 16 }, { header: '备注', width: 24 },
    ],
    rows,
  );
  ws.getRow(4 + rows.length).font = { bold: true };
  return wb;
}

export function buildTracesExport(traces: Trace[], ctx: LedgerData, meta: ExportMeta) {
  const acc = new Map(ctx.accounts.map((a) => [a.id, a]));
  const fl = new Map(ctx.flows.map((f) => [f.id, f]));
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('资金链汇总');
  const status = { OPEN: '进行中', CLOSED: '已闭环', ABNORMAL: '异常' };
  watermark(s1, '资金链汇总', 12, meta);
  table(
    s1,
    4,
    [
      { header: '链路号', width: 18 }, { header: '起点', width: 40 }, { header: '起始日期', width: 12, date: true }, { header: '起始金额', width: 14, money: true },
      { header: '已落地费用', width: 14, money: true }, { header: '往来流出', width: 14, money: true }, { header: '留存公户', width: 14, money: true },
      { header: '滞留个人/现金', width: 14, money: true }, { header: '外部待说明', width: 14, money: true }, { header: '经过个人/现金', width: 10 },
      { header: '状态', width: 8 }, { header: '异常原因', width: 30 },
    ],
    traces.map((t) => {
      const r = fl.get(t.rootFlowId)!;
      return [`T-${r.flowNo.slice(1)}`, `${acc.get(r.fromAccountId)?.name} → ${acc.get(r.toAccountId)?.name}`, asDate(r.date), yuan(t.rootAmount), yuan(t.landed), yuan(t.outflow), yuan(t.retained), yuan(t.held), yuan(t.external), t.viaPerson ? '是' : '', status[t.status], t.reasons.join('；')];
    }),
  );
  const s2 = wb.addWorksheet('链路明细');
  watermark(s2, '资金链明细（每行一步流转，金额为归属本链的部分）', 8, meta);
  table(
    s2,
    4,
    [
      { header: '链路号', width: 18 }, { header: '层级', width: 6 }, { header: '流水号', width: 16 }, { header: '日期', width: 12, date: true },
      { header: '转出', width: 26 }, { header: '转入', width: 26 }, { header: '流水金额', width: 14, money: true }, { header: '归属本链金额', width: 14, money: true },
    ],
    traces.flatMap((t) =>
      t.edges.map((e) => {
        const f = fl.get(e.flowId)!;
        return [`T-${fl.get(t.rootFlowId)!.flowNo.slice(1)}`, e.depth + 1, f.flowNo, asDate(f.date), acc.get(e.from)?.name, acc.get(e.to)?.name, yuan(f.amount), yuan(Math.round(e.value))];
      }),
    ),
  );
  return wb;
}

export function buildTableExport(title: string, headers: TableHeader[], rows: unknown[][], meta: ExportMeta) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.replace(/[\\/?*[\]:]/g, '').slice(0, 30));
  watermark(ws, title, headers.length, meta);
  table(ws, 4, headers, rows);
  return wb;
}

export { ACCOUNT_KIND };
