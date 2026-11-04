// 模拟数据：主体、项目、交易对手取自 excel/ 下的现有日记账；张xx、李老板一链对应 require.md 的场景。
// 纳税人身份为演示用的假设值。用于后端 `npm run seed` 初始化演示库。
import type { Account, Category, Entity, Flow, FlowMethod, FlowSplit, IcNature, Invoice, Project, TaxKind, TaxProfile, TaxRule } from './types';
import { autoAllocate } from './selectors';

const rawEntities: Omit<Entity, 'taxProfiles' | 'status'>[] = [
  { id: 'e1', code: 'E01', name: '天津祺羽商贸有限公司', shortName: '祺羽', kind: 'INDEPENDENT', taxpayerType: 'SMALL', vatFiling: 'QUARTER', region: '天津' },
  { id: 'e2', code: 'E27', name: '贵州中汉建设有限公司', shortName: '中汉', kind: 'HEAD', taxpayerType: 'GENERAL', vatFiling: 'MONTH', region: '贵州贵阳' },
  { id: 'e3', code: 'E27-1', name: '贵州中汉建设有限公司夏河县分公司', shortName: '中汉夏河', kind: 'BRANCH', parentId: 'e2', taxpayerType: 'GENERAL', vatFiling: 'MONTH', region: '甘肃夏河' },
  { id: 'e4', code: 'E28', name: '甘肃擎宇建设工程有限公司', shortName: '擎宇', kind: 'INDEPENDENT', taxpayerType: 'GENERAL', vatFiling: 'MONTH', region: '甘肃广河' },
  { id: 'e5', code: 'E29', name: '甘肃凌岳建设有限公司', shortName: '凌岳', kind: 'HEAD', taxpayerType: 'GENERAL', vatFiling: 'MONTH', region: '甘肃兰州' },
  { id: 'e6', code: 'E29-1', name: '甘肃凌岳建设有限公司迭部分公司', shortName: '凌岳迭部', kind: 'BRANCH', parentId: 'e5', taxpayerType: 'SMALL', vatFiling: 'QUARTER', region: '甘肃迭部' },
];

const profile = (e: Omit<Entity, 'taxProfiles' | 'status'>, validFrom = '2024-01-01'): TaxProfile => ({
  taxpayerType: e.taxpayerType, vatFiling: e.vatFiling, validFrom, urbanRate: e.region.includes('天津') || e.region.includes('兰州') || e.region.includes('贵阳') ? 0.07 : 0.05, halving: e.taxpayerType === 'SMALL',
});

export const entities: Entity[] = rawEntities.map((e) => ({
  ...e,
  status: 'ACTIVE',
  // 中汉夏河演示身份变更：2025 年为小规模，2026-01-01 起登记为一般纳税人
  taxProfiles:
    e.id === 'e3'
      ? [{ ...profile(e), taxpayerType: 'SMALL', vatFiling: 'QUARTER', halving: true, validTo: '2026-01-01' }, profile(e, '2026-01-01')]
      : [profile(e)],
}));


const rawAccounts: Omit<Account, 'status'>[] = [
  // 对公
  { id: 'a-e1', code: 'A-E01-01', name: '祺羽-建行基本户', kind: 'CORPORATE', entityId: 'e1', bank: '建设银行', last4: '1021', trace: 'REQUIRED' },
  { id: 'a-e2', code: 'A-E27-01', name: '中汉-工行基本户', kind: 'CORPORATE', entityId: 'e2', bank: '工商银行', last4: '3307', trace: 'REQUIRED' },
  { id: 'a-e3', code: 'A-E27-11', name: '中汉夏河-农行基本户', kind: 'CORPORATE', entityId: 'e3', bank: '农业银行', last4: '5512', trace: 'REQUIRED' },
  { id: 'a-e4', code: 'A-E28-01', name: '擎宇-农行基本户', kind: 'CORPORATE', entityId: 'e4', bank: '农业银行', last4: '8826', trace: 'REQUIRED' },
  { id: 'a-e5', code: 'A-E29-01', name: '凌岳-工行基本户', kind: 'CORPORATE', entityId: 'e5', bank: '工商银行', last4: '0418', trace: 'REQUIRED' },
  { id: 'a-e6', code: 'A-E29-11', name: '凌岳迭部-农行基本户', kind: 'CORPORATE', entityId: 'e6', bank: '农业银行', last4: '7790', trace: 'REQUIRED' },
  // 内部个人 / 现金（具体名单由管理员维护，此处为演示）
  { id: 'p-ning', code: 'I-001', name: '宁晓花-农行卡', kind: 'INTERNAL_PERSONAL', holder: '宁晓花', bank: '农业银行', last4: '6631', trace: 'REQUIRED' },
  { id: 'p-yang', code: 'I-002', name: '杨燕花-建行卡', kind: 'INTERNAL_PERSONAL', holder: '杨燕花', bank: '建设银行', last4: '2290', trace: 'REQUIRED' },
  { id: 'p-zhang', code: 'I-003', name: '张xx-工行卡', kind: 'INTERNAL_PERSONAL', holder: '张xx', bank: '工商银行', last4: '4416', trace: 'REQUIRED' },
  { id: 'c-zhang', code: 'C-001', name: '张xx-现金', kind: 'CASH', holder: '张xx', trace: 'REQUIRED' },
  // 外部
  { id: 'x-li', code: 'X-001', name: '李老板-个人卡', kind: 'EXTERNAL', holder: '李老板', trace: 'OPTIONAL' },
  { id: 'x-hebei', code: 'X-002', name: '河北揽升交通安防设施有限公司', kind: 'EXTERNAL', trace: 'OPTIONAL' },
  { id: 'x-shaanxi', code: 'X-003', name: '陕西创建园林绿化公司', kind: 'EXTERNAL', trace: 'OPTIONAL' },
  { id: 'x-xinhong', code: 'X-004', name: '甘肃鑫宏驰工程管理咨询有限公司', kind: 'EXTERNAL', trace: 'OPTIONAL' },
  { id: 'x-nongye', code: 'X-005', name: '迭部县农业农村和科学技术局零余额账户', kind: 'EXTERNAL', trace: 'OPTIONAL' },
  { id: 'x-guanghe', code: 'X-006', name: '广河县城乡基础设施建设投资有限责任公司', kind: 'EXTERNAL', trace: 'OPTIONAL' },
  { id: 'x-tingfan', code: 'X-007', name: '河北庭帆丝网制品有限公司', kind: 'EXTERNAL', trace: 'OPTIONAL' },
  { id: 'x-jincheng', code: 'X-008', name: '甘肃金诚顺超商贸有限公司', kind: 'EXTERNAL', trace: 'OPTIONAL' },
  { id: 'x-xintai', code: 'X-009', name: '甘肃信泰合不锈钢有限公司', kind: 'EXTERNAL', trace: 'OPTIONAL' },
  { id: 'x-wu', code: 'X-010', name: '吴永兵', kind: 'EXTERNAL', holder: '吴永兵', trace: 'OPTIONAL' },
  { id: 'x-wang', code: 'X-011', name: '王燕雪', kind: 'EXTERNAL', holder: '王燕雪', trace: 'OPTIONAL' },
  { id: 'x-zhu', code: 'X-013', name: '祝建龙', kind: 'EXTERNAL', holder: '祝建龙', trace: 'OPTIONAL' },
  { id: 'x-workers', code: 'X-012', name: '工人工资代发（多人）', kind: 'EXTERNAL', trace: 'OPTIONAL' },
  // 虚拟
  { id: 'v-open', code: 'V-OPEN', name: '期初', kind: 'VIRTUAL', virtualKind: 'OPENING', trace: 'NONE' },
  { id: 'v-tax', code: 'V-TAX', name: '国家金库（税务）', kind: 'VIRTUAL', virtualKind: 'TAX', trace: 'NONE' },
  { id: 'v-social', code: 'V-SOCIAL', name: '社保', kind: 'VIRTUAL', virtualKind: 'SOCIAL', trace: 'NONE' },
  { id: 'v-fee', code: 'V-FEE', name: '银行手续费', kind: 'VIRTUAL', virtualKind: 'BANK_FEE', trace: 'NONE' },
  { id: 'v-interest', code: 'V-INT', name: '银行结息', kind: 'VIRTUAL', virtualKind: 'BANK_INTEREST', trace: 'NONE' },
  { id: 'v-loss', code: 'V-LOSS', name: '损失核销', kind: 'VIRTUAL', virtualKind: 'LOSS', trace: 'NONE' },
];

export const accounts: Account[] = rawAccounts.map((a) => ({ ...a, status: 'ACTIVE' }));


const c = (id: string, name: string, nature: Category['nature'], affectsPnl: boolean, parentId?: string, requiresTax?: boolean): Category =>
  ({ id, name, nature, affectsPnl, parentId, requiresTax });

export const categories: Category[] = [
  c('c-wage', '人员工资', 'EXPENSE', true),
  c('c-wage-base', '基本工资', 'EXPENSE', true, 'c-wage'),
  c('c-wage-labor', '劳务费', 'EXPENSE', true, 'c-wage'),
  c('c-wage-bonus', '绩效奖金', 'EXPENSE', true, 'c-wage'),
  c('c-mat', '项目材料费', 'EXPENSE', true),
  c('c-mat-main', '主材', 'EXPENSE', true, 'c-mat'),
  c('c-mat-plant', '苗木', 'EXPENSE', true, 'c-mat'),
  c('c-mat-fence', '围栏丝网', 'EXPENSE', true, 'c-mat'),
  c('c-mat-freight', '运输费', 'EXPENSE', true, 'c-mat'),
  c('c-reimb', '人员报销', 'EXPENSE', true),
  c('c-reimb-travel', '差旅', 'EXPENSE', true, 'c-reimb'),
  c('c-reimb-meal', '餐饮招待', 'EXPENSE', true, 'c-reimb'),
  c('c-reimb-office', '办公用品', 'EXPENSE', true, 'c-reimb'),
  c('c-sub', '外包/分包费', 'EXPENSE', true),
  c('c-sub-labor', '劳务分包', 'EXPENSE', true, 'c-sub'),
  c('c-tax', '税费', 'TAX', true),
  c('c-tax-vat', '增值税', 'TAX', true, 'c-tax', true),
  c('c-tax-sur', '附加税', 'TAX', true, 'c-tax', true),
  c('c-tax-iit', '个税代缴', 'TAX', false, 'c-tax', true),
  c('c-tax-social', '社保', 'TAX', true, 'c-tax', true),
  c('c-admin', '管理费用', 'EXPENSE', true),
  c('c-admin-rent', '房租物业', 'EXPENSE', true, 'c-admin'),
  c('c-admin-other', '其他管理费用', 'EXPENSE', true, 'c-admin'),
  c('c-fin', '财务费用', 'EXPENSE', true),
  c('c-fin-fee', '银行手续费', 'EXPENSE', true, 'c-fin'),
  c('c-fin-interest', '利息收入', 'INCOME', true, 'c-fin'),
  c('c-inc', '项目收入', 'INCOME', true),
  c('c-inc-progress', '进度款', 'INCOME', true, 'c-inc'),
  c('c-inc-labor', '劳务收入', 'INCOME', true, 'c-inc'),
  c('c-trf', '内部划转', 'TRANSFER', false),
  c('c-trf-advance', '公户→个人代管', 'TRANSFER', false, 'c-trf'),
  c('c-trf-withdraw', '取现', 'TRANSFER', false, 'c-trf'),
  c('c-trf-handover', '现金交付', 'TRANSFER', false, 'c-trf'),
  c('c-trf-return', '回流公户', 'TRANSFER', false, 'c-trf'),
  c('c-trf-opening', '期初', 'TRANSFER', false, 'c-trf'),
  c('c-cur', '往来款', 'CURRENT', false),
  c('c-cur-ic', '集团内往来', 'CURRENT', false, 'c-cur'),
  c('c-cur-loan', '借款', 'CURRENT', false, 'c-cur'),
  c('c-cur-repay', '还款', 'CURRENT', false, 'c-cur'),
];

const W = 100; // 元 → 分

export const projects: Project[] = [
  { id: 'pj1', code: 'P-LYDB-001', name: '迭部县多儿乡布后村耕地围栏建设项目', entityId: 'e6', kind: 'NORMAL', manager: '杨燕花', customer: '迭部县农业农村和科学技术局', region: '甘肃迭部', vatMethod: 'SIMPLE', contractAmount: 980000 * W, budget: { 'c-mat': 520000 * W, 'c-wage': 220000 * W, 'c-reimb': 20000 * W }, status: 'ACTIVE', startDate: '2025-10-01' },
  { id: 'pj2', code: 'P-LYDB-002', name: '迭部县卡坝乡娘玉村农田围栏建设项目', entityId: 'e6', kind: 'NORMAL', manager: '宁晓花', customer: '迭部县农业农村和科学技术局', region: '甘肃迭部', vatMethod: 'SIMPLE', contractAmount: 760000 * W, budget: { 'c-mat': 300000 * W, 'c-wage': 150000 * W }, status: 'ACTIVE', startDate: '2025-10-15' },
  { id: 'pj3', code: 'P-QY-001', name: '县城及三甲集镇绿化建设工程', entityId: 'e4', kind: 'NORMAL', manager: '白总', customer: '广河县城乡基础设施建设投资有限责任公司', region: '甘肃广河', vatMethod: 'GENERAL', contractAmount: 2600000 * W, budget: { 'c-mat': 900000 * W, 'c-wage': 700000 * W, 'c-reimb': 50000 * W }, status: 'ACTIVE', startDate: '2025-08-01' },
  { id: 'pj4', code: 'P-QY-002', name: '迭部县电尕镇亚古麻古村饮水安全巩固提升项目', entityId: 'e4', kind: 'NORMAL', manager: '白总', region: '甘肃迭部', vatMethod: 'GENERAL', contractAmount: 420000 * W, budget: { 'c-mat': 150000 * W, 'c-wage': 120000 * W }, status: 'ACTIVE', startDate: '2025-11-01' },
  { id: 'pj5', code: 'P-QY-003', name: '张磊店装修工程', entityId: 'e4', kind: 'NORMAL', manager: '张磊', region: '甘肃兰州', vatMethod: 'GENERAL', contractAmount: 300000 * W, budget: { 'c-mat': 120000 * W, 'c-wage': 130000 * W }, status: 'CLOSED', startDate: '2025-12-01' },
  { id: 'pj6', code: 'P-ZHXH-001', name: '夏河县乡村道路养护项目', entityId: 'e3', kind: 'NORMAL', manager: '王xx', region: '甘肃夏河', vatMethod: 'GENERAL', contractAmount: 500000 * W, budget: { 'c-mat': 200000 * W }, status: 'PREPARING', startDate: '2026-12-01' },
  ...entities.map<Project>((e) => ({
    id: `pc-${e.id}`, code: `P-${e.code}-COMMON`, name: `${e.shortName}·公司公共`, entityId: e.id, kind: 'COMMON',
    manager: '财务', vatMethod: 'GENERAL', contractAmount: 0, budget: {}, status: 'ACTIVE',
  })),
];

interface Seed {
  key: string;
  date: string;
  yuan: number;
  from: string;
  to: string;
  method: FlowMethod;
  project: string;
  cat: string;
  book?: string;
  actual?: string;
  mismatch?: boolean;
  ic?: IcNature;
  tax?: TaxKind;
  taxPeriod?: string;
  src?: [string, number][]; // 显式指定来源（入款 key, 元）；不填则 FIFO
  handler?: string;
  remark?: string;
  invoiceNos?: string[];
}

const S = (key: string, date: string, yuan: number, from: string, to: string, method: FlowMethod, project: string, cat: string, extra: Partial<Seed> = {}): Seed =>
  ({ key, date, yuan, from, to, method, project, cat, ...extra });

const seeds: Seed[] = [
  // —— 凌岳迭部分公司 ——
  S('ly0', '2025-10-01', 1000, 'v-open', 'a-e6', 'OTHER', 'pc-e6', 'c-trf-opening', { book: '期初余额' }),
  S('ly0a', '2025-10-21', 60000, 'x-zhu', 'a-e6', 'BANK_TRANSFER', 'pj2', 'c-cur-loan', { book: '收到祝建龙借款' }),
  S('ly0b', '2025-12-25', 60000, 'a-e6', 'x-zhu', 'BANK_TRANSFER', 'pj2', 'c-cur-repay', { book: '支付祝建龙还款' }),
  S('ly1', '2025-10-22', 60062, 'a-e6', 'x-hebei', 'CORPORATE_TRANSFER', 'pj2', 'c-mat-fence', { book: '支付河北揽升交通安防设施有限公司围栏款' }),
  S('ly2', '2025-11-28', 225862.5, 'x-nongye', 'a-e6', 'CORPORATE_TRANSFER', 'pj2', 'c-inc-progress', { book: '迭部县农业农村和科学技术局零余额账户' }),
  S('ly3', '2025-11-28', 116887.5, 'x-nongye', 'a-e6', 'CORPORATE_TRANSFER', 'pj2', 'c-inc-progress'),
  S('ly4', '2025-11-28', 20, 'a-e6', 'v-fee', 'BANK_TRANSFER', 'pc-e6', 'c-fin-fee', { book: '收费' }),
  S('ly5', '2025-12-11', 185138, 'a-e6', 'x-hebei', 'CORPORATE_TRANSFER', 'pj2', 'c-mat-fence', { book: '支付河北揽升交通安防设施有限公司围栏款', invoiceNos: ['25132000000081234567'] }),
  S('ly6', '2025-12-12', 301150, 'x-nongye', 'a-e6', 'CORPORATE_TRANSFER', 'pj1', 'c-inc-progress'),
  S('ly7', '2025-12-12', 155850, 'x-nongye', 'a-e6', 'CORPORATE_TRANSFER', 'pj1', 'c-inc-progress'),
  S('ly8', '2025-12-25', 68750, 'x-xinhong', 'a-e6', 'CORPORATE_TRANSFER', 'pj1', 'c-inc-labor', { book: '收到甘肃鑫宏驰工程管理咨询有限公司劳务费' }),
  S('ly9', '2025-12-29', 82970, 'x-xinhong', 'a-e6', 'CORPORATE_TRANSFER', 'pj1', 'c-inc-labor'),
  S('ly10', '2025-12-30', 66000, 'a-e6', 'x-workers', 'BANK_TRANSFER', 'pj1', 'c-wage-labor', { book: '杜春辉、豆玲瑛等14人', remark: '多儿乡布后村围栏工人工资' }),
  S('ly11', '2026-01-05', 15000, 'a-e6', 'x-wang', 'BANK_TRANSFER', 'pc-e6', 'c-admin-rent', { book: '支付王燕雪工资', actual: '颐和小区房租14000元 + 物业费1000元', mismatch: true }),
  S('ly12', '2026-01-06', 200000, 'a-e6', 'p-ning', 'BANK_TRANSFER', 'pj1', 'c-trf-advance', { book: '支付宁晓花借款', actual: '项目备用金，由宁晓花代管' }),
  S('ly13', '2026-04-15', 12500, 'a-e6', 'x-xintai', 'CORPORATE_TRANSFER', 'pj1', 'c-mat-main', { book: '支付甘肃信泰合不锈钢有限公司铁艺大门费', actual: '实际购买布草条', mismatch: true }),
  S('ly14', '2026-04-28', 50000, 'p-ning', 'a-e6', 'BANK_TRANSFER', 'pj1', 'c-trf-return', { book: '收到宁晓花还款' }),
  S('ly15', '2026-04-29', 35688, 'p-ning', 'x-shaanxi', 'BANK_TRANSFER', 'pj1', 'c-mat-plant', { book: '绿化苗木款', handler: '宁晓花' }),
  S('ly16', '2026-04-29', 40000, 'p-ning', 'a-e6', 'BANK_TRANSFER', 'pj1', 'c-trf-return', { book: '收到宁晓花还款' }),
  S('ly17', '2026-05-11', 32180, 'p-ning', 'x-shaanxi', 'BANK_TRANSFER', 'pj1', 'c-mat-plant', { book: '绿化苗木款', handler: '宁晓花' }),
  S('ly18', '2026-05-11', 30000, 'p-ning', 'a-e6', 'BANK_TRANSFER', 'pj1', 'c-trf-return', { book: '收到宁晓花还款' }),
  S('ly19', '2026-04-28', 210100, 'a-e6', 'x-tingfan', 'CORPORATE_TRANSFER', 'pj1', 'c-mat-fence', { book: '支付河北庭帆丝网制品有限公司' }),
  S('ly20', '2026-07-08', 1856.4, 'a-e6', 'v-tax', 'BANK_TRANSFER', 'pc-e6', 'c-tax-vat', { book: '中华人民共和国国家金库迭部县支库', tax: 'VAT', taxPeriod: '2026-Q2' }),
  S('ly21', '2026-10-12', 120000, 'x-nongye', 'a-e6', 'CORPORATE_TRANSFER', 'pj1', 'c-inc-progress'),
  // —— 擎宇 ——
  S('qy1', '2025-12-18', 1430000, 'x-guanghe', 'a-e4', 'CORPORATE_TRANSFER', 'pj3', 'c-inc-labor', { book: '广河县城乡基础设施建设投资有限责任公司', remark: '劳务费（县城及三甲集镇绿化建设工程）', invoiceNos: ['25622000000012345678'] }),
  S('qy2', '2025-12-20', 5.97, 'v-interest', 'a-e4', 'BANK_TRANSFER', 'pc-e4', 'c-fin-interest', { book: '利息' }),
  S('qy3', '2025-12-23', 16000, 'a-e4', 'x-wu', 'BANK_TRANSFER', 'pj3', 'c-wage-base', { book: '支付吴永兵工资', remark: '白总让转' }),
  S('qy4', '2025-12-23', 13.5, 'a-e4', 'v-fee', 'BANK_TRANSFER', 'pc-e4', 'c-fin-fee', { book: '转账手续费' }),
  S('qy5', '2026-01-06', 350000, 'a-e4', 'p-yang', 'BANK_TRANSFER', 'pj4', 'c-trf-advance', { book: '支付杨燕花借款', actual: '项目资金，由杨燕花代管' }),
  S('qy6', '2026-01-15', 14866.33, 'a-e4', 'v-tax', 'BANK_TRANSFER', 'pc-e4', 'c-tax-vat', { book: '中华人民共和国国家金库迭部县支库', tax: 'VAT', taxPeriod: '2025-12' }),
  S('qy7', '2026-01-22', 50000, 'p-yang', 'a-e4', 'BANK_TRANSFER', 'pj4', 'c-trf-return', { book: '收到杨燕花还款' }),
  S('qy8', '2026-01-23', 50000, 'p-yang', 'a-e4', 'BANK_TRANSFER', 'pj4', 'c-trf-return', { book: '收到杨燕花还款' }),
  S('qy9', '2026-01-27', 50000, 'p-yang', 'a-e4', 'BANK_TRANSFER', 'pj4', 'c-trf-return', { book: '收到杨燕花还款' }),
  S('qy10', '2026-01-28', 100000, 'p-yang', 'a-e4', 'BANK_TRANSFER', 'pj4', 'c-trf-return', { book: '收到杨燕花还款' }),
  S('qy11', '2026-02-10', 45000, 'p-yang', 'x-workers', 'BANK_TRANSFER', 'pj4', 'c-wage-labor', { book: '加曼草、道吉日青等工人工资', handler: '杨燕花' }),
  S('qy12', '2026-03-16', 6144, 'a-e4', 'x-jincheng', 'CORPORATE_TRANSFER', 'pc-e4', 'c-reimb-meal', { book: '支付甘肃金诚顺超商贸有限公司酒款' }),
  S('qy13', '2026-04-24', 2011.06, 'a-e4', 'v-social', 'BANK_TRANSFER', 'pc-e4', 'c-tax-social', { book: '中华人民共和国国家金库迭部县支库', remark: '白霞社保', tax: 'SOCIAL', taxPeriod: '2026-04' }),
  S('qy14', '2026-06-01', 30000, 'p-yang', 'a-e4', 'BANK_TRANSFER', 'pj4', 'c-trf-return', { book: '收到杨燕花还款' }),
  S('qy15', '2026-06-02', 80000, 'a-e1', 'a-e4', 'CORPORATE_TRANSFER', 'pc-e4', 'c-cur-ic', { book: '收到祺羽借款', ic: 'LOAN' }),
  S('qy16', '2026-10-15', 25000, 'p-yang', 'a-e4', 'BANK_TRANSFER', 'pj4', 'c-trf-return', { book: '收到杨燕花还款' }),
  // 需求场景：公户 → 张xx卡 → 取现 → 现金交付李老板 → 李老板转入凌岳迭部公户
  S('zx1', '2026-09-01', 100000, 'a-e4', 'p-zhang', 'BANK_TRANSFER', 'pj3', 'c-trf-advance', { book: '转张xx', actual: '项目现场用款', handler: '张xx' }),
  S('zx2', '2026-09-03', 60000, 'p-zhang', 'c-zhang', 'CASH_WITHDRAW', 'pj3', 'c-trf-withdraw', { handler: '张xx' }),
  S('zx3', '2026-09-05', 30000, 'p-zhang', 'x-tingfan', 'BANK_TRANSFER', 'pj3', 'c-mat-fence', { book: '丝网款', handler: '张xx' }),
  S('zx4', '2026-09-08', 60000, 'c-zhang', 'x-li', 'CASH_HANDOVER', 'pj3', 'c-trf-handover', { handler: '张xx', remark: '现金交李老板' }),
  S('zx5', '2026-09-20', 58000, 'x-li', 'a-e6', 'CORPORATE_TRANSFER', 'pj3', 'c-trf-return', { book: '李老板转入', src: [['zx4', 58000]], remark: '差额 2000 待说明' }),
  // 近期
  S('qy17', '2026-11-01', 300000, 'x-guanghe', 'a-e4', 'CORPORATE_TRANSFER', 'pj3', 'c-inc-progress', {}),
  S('qy18', '2026-11-02', 45000, 'a-e4', 'x-shaanxi', 'CORPORATE_TRANSFER', 'pj3', 'c-mat-plant', { book: '苗木款' }),
  S('zx6', '2026-10-28', 4200, 'p-zhang', 'x-workers', 'WECHAT', 'pj3', 'c-reimb-travel', { handler: '张xx', book: '现场人员差旅' }),
  // —— 中汉夏河 ——
  S('zh0', '2026-01-01', 697.4, 'v-open', 'a-e3', 'OTHER', 'pc-e3', 'c-trf-opening', { book: '上月余额' }),
  S('zh1', '2026-01-12', 480, 'a-e3', 'v-tax', 'BANK_TRANSFER', 'pc-e3', 'c-tax-vat', { book: '中华人民共和国国家金库夏河县支库', tax: 'VAT', taxPeriod: '2025-12' }),
  S('zh2', '2026-01-16', 20, 'a-e3', 'v-fee', 'BANK_TRANSFER', 'pc-e3', 'c-fin-fee', { book: '银行收费' }),
  S('zh3', '2026-03-20', 0.04, 'v-interest', 'a-e3', 'BANK_TRANSFER', 'pc-e3', 'c-fin-interest', { book: '收到结息' }),
  // —— 祺羽 ——
  S('qi1', '2026-05-30', 200000, 'x-xinhong', 'a-e1', 'CORPORATE_TRANSFER', 'pc-e1', 'c-inc-labor', { book: '劳务结算' }),
];

const toFlow = (s: Seed, i: number): Flow => {
  const split: FlowSplit = { projectId: s.project, categoryId: s.cat, amount: Math.round(s.yuan * W), tax: s.tax, taxPeriod: s.taxPeriod };
  return {
    id: s.key,
    flowNo: `F${s.date.slice(0, 4)}${s.date.slice(5, 7)}-${String(i + 1).padStart(6, '0')}`,
    date: s.date,
    amount: Math.round(s.yuan * W),
    fromAccountId: s.from,
    toAccountId: s.to,
    method: s.method,
    bookSummary: s.book,
    actualPurpose: s.actual,
    purposeMismatch: s.mismatch,
    icNature: s.ic,
    handler: s.handler,
    invoiceNos: s.invoiceNos,
    splits: [split],
    allocations: (s.src ?? []).map(([k, y]) => ({ lotFlowId: k, amount: Math.round(y * W), auto: false })),
    status: 'CONFIRMED',
    remark: s.remark,
    createdAt: `${s.date}T10:00:00`,
  };
};

/** 按日期顺序生成流水；溯源账户的出款按"同项目优先、先进先出"自动分配来源（与正式系统录入规则一致） */
function buildFlows(): Flow[] {
  const ordered = [...seeds].sort((a, b) => a.date.localeCompare(b.date));
  const out: Flow[] = [];
  ordered.forEach((s, i) => {
    const f = toFlow(s, i);
    const from = accounts.find((a) => a.id === f.fromAccountId)!;
    if (from.trace === 'REQUIRED' && f.allocations.length === 0) {
      const r = autoAllocate(out, accounts, f.fromAccountId, f.amount, { asOf: f.date, preferProjectId: f.splits[0].projectId });
      if (!r.ok) throw new Error(`seed ${s.key}: 资金来源不足`);
      f.allocations = r.allocations;
    }
    out.push(f);
  });
  return out;
}

export const flows: Flow[] = buildFlows();

const inv = (id: string, direction: Invoice['direction'], type: Invoice['type'], date: string, entityId: string, projectId: string | undefined, counterparty: string, excl: number, rate: number, goods: string): Invoice =>
  ({ id, direction, type, invoiceNo: `2${date.replace(/-/g, '').slice(2)}${id.padStart(8, '0')}`, issueDate: date, entityId, projectId, counterparty, amountExclTax: Math.round(excl * W), taxRate: rate, taxAmount: Math.round(excl * rate * W), goods });

export const invoices: Invoice[] = [
  inv('1', 'OUTPUT', 'VAT_SPECIAL', '2025-12-16', 'e4', 'pj3', '广河县城乡基础设施建设投资有限责任公司', 1311926.61, 0.09, '建筑服务*绿化工程'),
  inv('2', 'INPUT', 'VAT_SPECIAL', '2025-12-20', 'e4', 'pj3', '河北庭帆丝网制品有限公司', 26548.67, 0.13, '丝网'),
  inv('3', 'INPUT', 'VAT_NORMAL', '2026-03-16', 'e4', undefined, '甘肃金诚顺超商贸有限公司', 5437.17, 0.13, '酒水'),
  inv('4', 'OUTPUT', 'VAT_SPECIAL', '2026-10-30', 'e4', 'pj3', '广河县城乡基础设施建设投资有限责任公司', 275229.36, 0.09, '建筑服务*绿化工程'),
  inv('5', 'INPUT', 'VAT_SPECIAL', '2026-10-20', 'e4', 'pj3', '陕西创建园林绿化公司', 41284.4, 0.09, '苗木'),
  inv('6', 'OUTPUT', 'VAT_NORMAL', '2025-11-25', 'e6', 'pj2', '迭部县农业农村和科学技术局', 339356.44, 0.01, '建筑服务*围栏工程'),
  inv('7', 'OUTPUT', 'VAT_NORMAL', '2025-12-10', 'e6', 'pj1', '迭部县农业农村和科学技术局', 452475.25, 0.01, '建筑服务*围栏工程'),
  inv('8', 'OUTPUT', 'VAT_NORMAL', '2026-04-20', 'e6', 'pj1', '迭部县农业农村和科学技术局', 185643.56, 0.01, '建筑服务*围栏工程'),
  inv('9', 'INPUT', 'VAT_SPECIAL', '2026-04-28', 'e6', 'pj1', '河北庭帆丝网制品有限公司', 185929.2, 0.13, '丝网'),
  inv('10', 'OUTPUT', 'VAT_NORMAL', '2026-05-28', 'e1', undefined, '甘肃鑫宏驰工程管理咨询有限公司', 198019.8, 0.01, '劳务服务'),
];

export const taxRules: Omit<TaxRule, 'id'>[] = [
  { tax: 'VAT', name: '增值税-一般纳税人（建筑服务 9%，按发票税率）', taxpayer: 'GENERAL', method: 'GENERAL', rate: 0.09, validFrom: '2019-04-01', policyRef: '财政部 税务总局 海关总署公告2019年第39号' },
  { tax: 'VAT', name: '增值税-一般纳税人简易计税', taxpayer: 'GENERAL', method: 'SIMPLE', rate: 0.03, validFrom: '2016-05-01' },
  { tax: 'VAT', name: '增值税-小规模（3% 减按 1%）', taxpayer: 'SMALL', rate: 0.01, thresholdAmount: 300000_00, thresholdPeriod: 'QUARTER', validFrom: '2023-01-01', policyRef: '财政部 税务总局公告2023年第19号' },
  { tax: 'VAT_PREPAY', name: '跨地区建筑服务预缴-一般纳税人', taxpayer: 'GENERAL', rate: 0.02, validFrom: '2016-05-01' },
  { tax: 'VAT_PREPAY', name: '跨地区建筑服务预缴-小规模', taxpayer: 'SMALL', rate: 0.01, validFrom: '2023-01-01' },
  { tax: 'EDU_SURCHARGE', name: '教育费附加', rate: 0.03, validFrom: '2005-10-01' },
  { tax: 'LOCAL_EDU_SURCHARGE', name: '地方教育附加', rate: 0.02, validFrom: '2011-01-01' },
];
