// 基础数据：每个环境都需要的账目类型、系统虚拟账户、税务规则、首个管理员。启动时幂等补齐。
import * as seed from '@ledger/shared/seed';
import { decimalFromCents as d } from '@ledger/shared/format';
import type { Sql } from './db';
import { config } from './config';
import { hashPassword } from './password';

const VIRTUAL = [
  { code: 'V-OPEN', name: '期初', kind: 'OPENING' },
  { code: 'V-TAX', name: '国家金库（税务）', kind: 'TAX' },
  { code: 'V-SOCIAL', name: '社保', kind: 'SOCIAL' },
  { code: 'V-FEE', name: '银行手续费', kind: 'BANK_FEE' },
  { code: 'V-INT', name: '银行结息', kind: 'BANK_INTEREST' },
  { code: 'V-LOSS', name: '损失核销', kind: 'LOSS' },
] as const;

export async function ensureBaseData(sql: Sql, log: (m: string) => void = console.log) {
  await sql.begin(async (tx) => {
    const [{ n: cats }] = await tx`SELECT count(*)::int AS n FROM category`;
    if (!cats) {
      let sort = 0;
      for (const c of seed.categories.filter((x) => !x.parentId)) {
        sort += 10;
        await tx`INSERT INTO category (id, name, nature, affects_pnl, requires_tax, sort) VALUES (${c.id}, ${c.name}, ${c.nature}, ${c.affectsPnl}, ${!!c.requiresTax}, ${sort})`;
      }
      for (const c of seed.categories.filter((x) => x.parentId)) {
        await tx`INSERT INTO category (id, parent_id, name, nature, affects_pnl, requires_tax, sort) VALUES (${c.id}, ${c.parentId!}, ${c.name}, ${c.nature}, ${c.affectsPnl}, ${!!c.requiresTax}, ${sort++})`;
      }
      log(`seeded ${seed.categories.length} categories`);
    }
    for (const v of VIRTUAL) {
      await tx`INSERT INTO account (code, name, kind, virtual_kind, trace) VALUES (${v.code}, ${v.name}, 'VIRTUAL', ${v.kind}, 'NONE') ON CONFLICT (virtual_kind) DO NOTHING`;
    }
    const [{ n: rules }] = await tx`SELECT count(*)::int AS n FROM tax_rule`;
    if (!rules) {
      for (const r of seed.taxRules) {
        await tx`INSERT INTO tax_rule (tax, name, taxpayer, method, rate, threshold_amount, threshold_period, valid_from, valid_to, policy_ref)
                 VALUES (${r.tax}, ${r.name}, ${r.taxpayer ?? null}, ${r.method ?? null}, ${r.rate}, ${r.thresholdAmount === undefined ? null : d(r.thresholdAmount)},
                         ${r.thresholdPeriod ?? null}, ${r.validFrom}, ${r.validTo ?? null}, ${r.policyRef ?? null})`;
      }
    }
    const [{ n: users }] = await tx`SELECT count(*)::int AS n FROM app_user`;
    if (!users) {
      await tx`INSERT INTO app_user (username, display_name, role, password_hash) VALUES ('admin', '管理员', 'ADMIN', ${await hashPassword(config.adminPassword)})`;
      log('created initial admin user "admin" (password from ADMIN_PASSWORD) — please change it after first login');
    }
  });
}
