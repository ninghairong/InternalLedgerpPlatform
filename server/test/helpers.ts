// 集成测试：连接 docker 中的 ledger_test 库，每个测试文件开始前清空重建。
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { connect, type Sql } from '../src/db';
import { migrate } from '../src/migrate';
import { ensureBaseData } from '../src/bootstrap';
import { invalidate } from '../src/snapshot';
import type { Snapshot } from '@ledger/shared/types';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5433/ledger_test';

export interface Ctx {
  sql: Sql;
  app: FastifyInstance;
  admin: string;
  finance: string;
  readonly: string;
}

export async function setup(): Promise<Ctx> {
  const sql = connect(TEST_DB);
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(sql, undefined, () => {});
  await ensureBaseData(sql, () => {});
  invalidate();
  const app = await buildApp(sql);
  const admin = await login(app, 'admin', 'admin123');
  for (const [u, role] of [['fin', 'FINANCE'], ['ro', 'READONLY']]) {
    await ok(call(app, admin, 'POST', '/api/users', { username: u, displayName: u, role, password: 'password1' }));
  }
  return { sql, app, admin, finance: await login(app, 'fin', 'password1'), readonly: await login(app, 'ro', 'password1') };
}

export async function teardown(ctx: Ctx) {
  await ctx.app.close();
  await ctx.sql.end();
}

export async function login(app: FastifyInstance, username: string, password: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  if (r.statusCode !== 200) throw new Error(`login failed: ${r.body}`);
  return r.json().token as string;
}

export async function call(app: FastifyInstance, token: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const r = await app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${token}` } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = r.headers['content-type']?.toString().includes('json') ? r.json() : r.rawPayload;
  return { status: r.statusCode, body };
}

/** 期望成功并返回结果 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ok<T = any>(p: Promise<{ status: number; body: unknown }>): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`expected success, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

export const snap = async (ctx: Ctx) => ok<Snapshot>(call(ctx.app, ctx.admin, 'GET', '/api/snapshot'));

/** 最小测试数据：两家主体（一般 / 小规模）、各一个公户、个人卡、现金、两个外部单位、两个项目 */
export async function basicFixture(ctx: Ctx) {
  const t = ctx.admin;
  const post = (url: string, body: unknown) => ok(call(ctx.app, t, 'POST', url, body)).then((r) => r.id as string);
  const e1 = await post('/api/entities', { code: 'E1', name: '甲公司', shortName: '甲', kind: 'INDEPENDENT', region: '兰州', profile: { taxpayerType: 'GENERAL', vatFiling: 'MONTH', validFrom: '2024-01-01', urbanRate: 0.07, halving: false } });
  const e2 = await post('/api/entities', { code: 'E2', name: '乙公司', shortName: '乙', kind: 'INDEPENDENT', region: '迭部', profile: { taxpayerType: 'SMALL', vatFiling: 'QUARTER', validFrom: '2024-01-01', urbanRate: 0.05, halving: true } });
  const corp1 = await post('/api/accounts', { code: 'A1', name: '甲-基本户', kind: 'CORPORATE', entityId: e1 });
  const corp2 = await post('/api/accounts', { code: 'A2', name: '乙-基本户', kind: 'CORPORATE', entityId: e2 });
  const zhang = await post('/api/accounts', { code: 'I1', name: '张三-工行卡', kind: 'INTERNAL_PERSONAL', holder: '张三' });
  const cash = await post('/api/accounts', { code: 'C1', name: '张三-现金', kind: 'CASH', holder: '张三' });
  const client = await post('/api/accounts', { code: 'X1', name: '客户甲', kind: 'EXTERNAL' });
  const supplier = await post('/api/accounts', { code: 'X2', name: '供应商乙', kind: 'EXTERNAL' });
  const p1 = await post('/api/projects', { code: 'P1', name: '项目一', entityId: e1, manager: '王', budget: { 'c-mat': 50000_00 } });
  const p2 = await post('/api/projects', { code: 'P2', name: '项目二', entityId: e1, manager: '王' });
  const s = await snap(ctx);
  const virt = (k: string) => s.accounts.find((a) => a.virtualKind === k)!.id;
  const common = (e: string) => s.projects.find((p) => p.entityId === e && p.kind === 'COMMON')!.id;
  return { e1, e2, corp1, corp2, zhang, cash, client, supplier, p1, p2, common1: common(e1), common2: common(e2), tax: virt('TAX'), fee: virt('BANK_FEE'), opening: virt('OPENING') };
}

export const flow = (date: string, amount: number, from: string, to: string, projectId: string, categoryId: string, extra: Record<string, unknown> = {}) => ({
  date, amount, fromAccountId: from, toAccountId: to, method: 'BANK_TRANSFER', splits: [{ projectId, categoryId, amount }], allocations: [], ...extra,
});
