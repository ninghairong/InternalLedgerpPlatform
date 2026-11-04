// 业务错误统一为 AppError；数据库触发器抛出的 "CODE: 说明" 转成 400 并保留中文说明
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what}不存在`);
export const forbidden = (message = '没有权限执行此操作') => new AppError(403, 'FORBIDDEN', message);

const CONSTRAINT_TEXT: Record<string, string> = {
  entity_name_key: '主体名称已存在',
  entity_code_key: '主体编号已存在',
  entity_uscc_key: '统一社会信用代码已存在',
  account_name_key: '账户名称已存在',
  account_code_key: '账户编号已存在',
  project_name_key: '项目名称已存在',
  project_code_key: '项目编号已存在',
  project_common_uq: '该主体已有"公司公共"项目',
  invoice_invoice_no_key: '发票号已存在',
  flow_bank_serial_uq: '同一账户下银行流水号重复',
  app_user_username_key: '用户名已存在',
  entity_tax_profile_entity_id_daterange_excl: '纳税人身份的生效区间与已有记录重叠',
  account_last4_check: '账号尾号应为 4 位数字',
  entity_tax_profile_urban_rate_check: '城建税率应为 7%、5% 或 1%',
};

export function fromDbError(e: unknown): AppError | undefined {
  const err = e as { code?: string; message?: string; constraint_name?: string };
  if (!err || typeof err !== 'object' || !err.code) return undefined;
  if (err.code === 'P0001') {
    const m = /^([A-Z_]+): (.*)$/s.exec(err.message ?? '');
    return new AppError(400, m?.[1] ?? 'DB_RULE', m?.[2] ?? err.message ?? '数据校验失败');
  }
  if (err.code === '23505' || err.code === '23P01' || err.code === '23514') {
    const text = CONSTRAINT_TEXT[err.constraint_name ?? ''];
    return new AppError(409, 'CONSTRAINT', text ?? `数据约束不满足（${err.constraint_name ?? err.message}）`);
  }
  if (err.code === '23503') return new AppError(400, 'FOREIGN_KEY', `引用的数据不存在（${err.constraint_name}）`);
  if (err.code === '22P02' || err.code === '22007' || err.code === '22008') return new AppError(400, 'INVALID_VALUE', `数据格式错误：${err.message}`);
  return undefined;
}
