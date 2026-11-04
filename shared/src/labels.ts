import type { AccountKind, FlowMethod, FlowStatus, IcNature, ProjectStatus, TaxKind, TraceMode } from './types';
import type { TraceStatus } from './selectors';

export const ACCOUNT_KIND: Record<AccountKind, { label: string; color: string }> = {
  CORPORATE: { label: '对公账户', color: 'blue' },
  INTERNAL_PERSONAL: { label: '内部个人', color: 'purple' },
  CASH: { label: '现金', color: 'gold' },
  EXTERNAL: { label: '外部往来', color: 'default' },
  VIRTUAL: { label: '虚拟', color: 'cyan' },
};

export const TRACE_MODE: Record<TraceMode, string> = { REQUIRED: '强制溯源', OPTIONAL: '可选溯源', NONE: '不溯源' };

export const FLOW_METHOD: Record<FlowMethod, string> = {
  BANK_TRANSFER: '银行转账', CORPORATE_TRANSFER: '对公转账', WECHAT: '微信', ALIPAY: '支付宝',
  CASH_WITHDRAW: '取现', CASH_DEPOSIT: '存现', CASH_HANDOVER: '现金交付', OTHER: '其他',
};

export const FLOW_STATUS: Record<FlowStatus, { label: string; color: string }> = {
  CONFIRMED: { label: '正常', color: 'green' },
  VOIDED: { label: '已撤销导入', color: 'default' },
  REVERSED: { label: '已冲销', color: 'red' },
};

export const IC_NATURE: Record<IcNature, string> = {
  LOAN: '借款', REPAYMENT: '还款', ON_BEHALF: '代付', SERVICE_SETTLEMENT: '劳务结算', FUND_ALLOCATION: '资金调拨',
};

export const TAX_KIND: Record<TaxKind, string> = {
  VAT: '增值税', VAT_PREPAY: '增值税预缴', SURCHARGE: '附加税', IIT: '个人所得税', CIT: '企业所得税', STAMP: '印花税', SOCIAL: '社保',
};

export const TRACE_STATUS: Record<TraceStatus, { label: string; color: string }> = {
  OPEN: { label: '进行中', color: 'processing' },
  CLOSED: { label: '已闭环', color: 'success' },
  ABNORMAL: { label: '异常', color: 'error' },
};

export const PROJECT_STATUS: Record<ProjectStatus, { label: string; color: string }> = {
  PREPARING: { label: '筹备', color: 'default' },
  ACTIVE: { label: '进行中', color: 'processing' },
  CLOSED: { label: '已结项', color: 'success' },
};
