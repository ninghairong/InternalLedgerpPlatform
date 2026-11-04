// 前后端共用的数据模型，字段与 docs/需求方案.md 对应。
// 金额在程序中一律以"分"为单位的整数表示，避免浮点误差；数据库中为 numeric(18,2)。

export type ID = string;

export type TaxpayerType = 'GENERAL' | 'SMALL';
export type EntityKind = 'HEAD' | 'BRANCH' | 'INDEPENDENT';

export interface Entity {
  id: ID;
  code: string;
  name: string;
  shortName: string;
  kind: EntityKind;
  parentId?: ID;
  taxpayerType: TaxpayerType; // 当前身份（= 最新一条纳税信息）
  vatFiling: 'MONTH' | 'QUARTER';
  region: string;
  uscc?: string;
  taxProfiles: TaxProfile[]; // 纳税人身份历史，按生效日期升序
  status: 'ACTIVE' | 'DISABLED';
}

export interface TaxProfile {
  taxpayerType: TaxpayerType;
  vatFiling: 'MONTH' | 'QUARTER';
  validFrom: string;
  validTo?: string; // 不含
  urbanRate: number; // 城建税率 0.07 / 0.05 / 0.01
  halving: boolean; // 六税两费减半
}

export type AccountKind = 'CORPORATE' | 'INTERNAL_PERSONAL' | 'CASH' | 'EXTERNAL' | 'VIRTUAL';
export type TraceMode = 'REQUIRED' | 'OPTIONAL' | 'NONE';

export interface Account {
  id: ID;
  code: string;
  name: string;
  kind: AccountKind;
  entityId?: ID;
  holder?: string;
  bank?: string;
  last4?: string;
  trace: TraceMode;
  virtualKind?: VirtualKind;
  status: 'ACTIVE' | 'DISABLED';
  remark?: string;
}

export type VirtualKind = 'OPENING' | 'TAX' | 'SOCIAL' | 'BANK_FEE' | 'BANK_INTEREST' | 'LOSS';

export type ProjectKind = 'NORMAL' | 'COMMON';
export type ProjectStatus = 'PREPARING' | 'ACTIVE' | 'CLOSED';

export interface Project {
  id: ID;
  code: string;
  name: string;
  entityId: ID;
  kind: ProjectKind;
  manager: string;
  customer?: string;
  region?: string;
  vatMethod: 'GENERAL' | 'SIMPLE';
  contractAmount: number;
  budget: Record<ID, number>; // 一级类型 id → 预算（分）
  status: ProjectStatus;
  startDate?: string;
}

export type CategoryNature = 'EXPENSE' | 'INCOME' | 'TRANSFER' | 'CURRENT' | 'TAX';

export interface Category {
  id: ID;
  parentId?: ID;
  name: string;
  nature: CategoryNature;
  affectsPnl: boolean;
  requiresTax?: boolean;
}

export type FlowMethod =
  | 'BANK_TRANSFER'
  | 'CORPORATE_TRANSFER'
  | 'WECHAT'
  | 'ALIPAY'
  | 'CASH_WITHDRAW'
  | 'CASH_DEPOSIT'
  | 'CASH_HANDOVER'
  | 'OTHER';

export type FlowStatus = 'CONFIRMED' | 'VOIDED' | 'REVERSED';

export type IcNature = 'LOAN' | 'REPAYMENT' | 'ON_BEHALF' | 'SERVICE_SETTLEMENT' | 'FUND_ALLOCATION';

export type TaxKind = 'VAT' | 'VAT_PREPAY' | 'SURCHARGE' | 'IIT' | 'CIT' | 'STAMP' | 'SOCIAL';

export interface FlowSplit {
  projectId: ID;
  categoryId: ID;
  amount: number;
  tax?: TaxKind;
  taxPeriod?: string; // YYYY-MM 或 YYYY-Qn
}

/** 出款的资金来源：从某笔入款（lot，以入款流水 id 标识）中取用 amount */
export interface Allocation {
  lotFlowId: ID;
  amount: number;
  auto: boolean;
}

export interface Flow {
  id: ID;
  flowNo: string;
  date: string; // YYYY-MM-DD
  amount: number;
  fromAccountId: ID;
  toAccountId: ID;
  method: FlowMethod;
  bookSummary?: string;
  actualPurpose?: string;
  purposeMismatch?: boolean;
  icNature?: IcNature;
  handler?: string;
  bankSerialNo?: string;
  invoiceNos?: string[];
  splits: FlowSplit[];
  allocations: Allocation[];
  status: FlowStatus;
  importBatchNo?: string;
  remark?: string;
  reversalReason?: string;
  attachmentCount?: number;
  createdBy?: string;
  createdAt: string;
}

export interface Invoice {
  id: ID;
  direction: 'OUTPUT' | 'INPUT';
  type: 'VAT_SPECIAL' | 'VAT_NORMAL';
  invoiceNo: string;
  issueDate: string;
  entityId: ID;
  projectId?: ID;
  counterparty: string;
  amountExclTax: number;
  taxRate: number; // 0.09 等
  taxAmount: number;
  goods: string;
  remark?: string;
}

export interface ImportBatch {
  id: ID;
  batchNo: string;
  template: string;
  fileName: string;
  createdAt: string;
  createdBy: string;
  total: number;
  committed: number;
  status: 'VALIDATED' | 'COMMITTED' | 'ROLLED_BACK';
}

export interface TaxRule {
  id: ID;
  tax: TaxKind | 'URBAN_MAINT' | 'EDU_SURCHARGE' | 'LOCAL_EDU_SURCHARGE';
  name: string;
  taxpayer?: TaxpayerType;
  method?: 'GENERAL' | 'SIMPLE';
  rate: number;
  thresholdAmount?: number; // 分
  thresholdPeriod?: 'MONTH' | 'QUARTER';
  reductionRatio?: number;
  validFrom: string;
  validTo?: string;
  policyRef?: string;
}

export interface Period {
  entityId: ID;
  period: string; // YYYY-MM
  status: 'OPEN' | 'CLOSED';
  closedBy?: string;
  closedAt?: string;
}

export type Role = 'ADMIN' | 'FINANCE' | 'READONLY';

export interface User {
  id: ID;
  username: string;
  displayName: string;
  role: Role;
  status: 'ACTIVE' | 'DISABLED';
  lastLoginAt?: string;
}

export interface Attachment {
  id: ID;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
}

export interface AuditEntry {
  id: ID;
  at: string;
  user: string;
  action: string;
  targetType: string;
  targetId?: string;
  summary?: string;
}

/** 外部账户上无法追回的差额核销（不发生资金移动，只说明去向） */
export interface Writeoff {
  id: ID;
  lotFlowId: ID;
  amount: number;
  categoryId: ID;
  reason: string;
  createdBy: string;
  createdAt: string;
}

export interface PayrollItem {
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
  netFlowId?: ID;
}

export interface PayrollBatch {
  id: ID;
  entityId: ID;
  month: string; // YYYY-MM
  seq: number;
  payAccountId: ID;
  payDate: string;
  importBatchNo?: string;
  voided: boolean; // 所属导入批次已撤销
  items: PayrollItem[];
}

/** 校验与计算所需的账务数据 */
export interface LedgerData {
  entities: Entity[];
  accounts: Account[];
  projects: Project[];
  categories: Category[];
  flows: Flow[];
}

/** 前端一次性加载的全量数据（5 人自用、数据量有限，读取在浏览器中计算；写入一律经后端校验） */
export interface Snapshot extends LedgerData {
  version: number;
  invoices: Invoice[];
  importBatches: ImportBatch[];
  taxRules: TaxRule[];
  periods: Period[];
  writeoffs: Writeoff[];
  payrolls: PayrollBatch[];
}
