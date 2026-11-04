import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ADMIN_ONLY, WRITE_ROLES } from '../app';
import { audit } from '../audit';
import { badRequest } from '../errors';
import { loadSnapshot } from '../snapshot';
import {
  addTaxProfile, closeProject, createAccount, createEntity, createProject, deleteInvoice, projectCloseChecks, saveInvoice, setPeriod, updateAccount, updateEntity, updateProject,
} from '../services/master';

// 金额字段一律为"分"的整数
const cents = z.number().int().min(0);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const opt = (s: z.ZodString) => s.optional().or(z.literal('').transform(() => undefined));

const profileSchema = z.object({
  taxpayerType: z.enum(['GENERAL', 'SMALL']),
  vatFiling: z.enum(['MONTH', 'QUARTER']),
  validFrom: date,
  urbanRate: z.union([z.literal(0.07), z.literal(0.05), z.literal(0.01)]),
  halving: z.boolean(),
});

const entitySchema = z.object({
  code: z.string().trim().min(1, '请填写编号'),
  name: z.string().trim().min(1, '请填写全称'),
  shortName: z.string().trim().min(1, '请填写简称'),
  uscc: opt(z.string().trim()),
  kind: z.enum(['HEAD', 'BRANCH', 'INDEPENDENT']),
  parentId: opt(z.string()),
  region: z.string().trim().min(1, '请填写所在地'),
});

const accountSchema = z.object({
  code: z.string().trim().min(1, '请填写编号'),
  name: z.string().trim().min(1, '请填写名称'),
  kind: z.enum(['CORPORATE', 'INTERNAL_PERSONAL', 'CASH', 'EXTERNAL']),
  entityId: opt(z.string()),
  holder: opt(z.string().trim()),
  bank: opt(z.string().trim()),
  last4: opt(z.string().regex(/^\d{4}$/, '尾号应为 4 位数字')),
  remark: opt(z.string()),
  opening: z.object({ amount: cents, date, projectId: opt(z.string()) }).optional(),
});

const projectSchema = z.object({
  code: z.string().trim().min(1, '请填写编号'),
  name: z.string().trim().min(1, '请填写名称'),
  entityId: z.string(),
  manager: z.string().trim().min(1, '请填写负责人'),
  customer: opt(z.string().trim()),
  region: opt(z.string().trim()),
  vatMethod: z.enum(['GENERAL', 'SIMPLE']).default('GENERAL'),
  contractAmount: cents.default(0),
  budget: z.record(z.string(), cents).default({}),
  startDate: opt(date),
  status: z.enum(['PREPARING', 'ACTIVE', 'CLOSED']).default('ACTIVE'),
});

const invoiceSchema = z.object({
  direction: z.enum(['OUTPUT', 'INPUT']),
  type: z.enum(['VAT_SPECIAL', 'VAT_NORMAL']),
  invoiceNo: z.string().trim().min(1, '请填写发票号'),
  issueDate: date,
  entityId: z.string(),
  projectId: opt(z.string()),
  counterparty: z.string().trim().min(1, '请填写对方单位'),
  amountExclTax: cents,
  taxRate: z.number().min(0).max(0.99),
  taxAmount: cents,
  goods: z.string().trim().min(1, '请填写货物或服务名称'),
  remark: opt(z.string()),
});

export default async function dataRoutes(app: FastifyInstance) {
  const read = { preHandler: app.auth() };
  const write = { preHandler: app.auth(WRITE_ROLES) };
  const admin = { preHandler: app.auth(ADMIN_ONLY) };

  app.get('/snapshot', read, async () => loadSnapshot(app.sql));

  // ---- 主体
  app.post('/entities', write, async (req) => {
    const body = entitySchema.extend({ profile: profileSchema }).parse(req.body);
    return { id: await app.write((tx) => createEntity(tx, body, body.profile, req.actor)) };
  });
  app.put('/entities/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    const body = entitySchema.omit({ code: true }).partial().extend({ status: z.enum(['ACTIVE', 'DISABLED']).optional() }).parse(req.body);
    await app.write((tx) => updateEntity(tx, id, body, req.actor));
    return { ok: true };
  });
  app.post('/entities/:id/tax-profiles', write, async (req) => {
    const { id } = req.params as { id: string };
    const body = profileSchema.parse(req.body);
    await app.write((tx) => addTaxProfile(tx, id, body, req.actor));
    return { ok: true };
  });

  // ---- 账户
  app.post('/accounts', write, async (req) => {
    const body = accountSchema.parse(req.body);
    return { id: await app.write((tx) => createAccount(tx, body, req.actor)) };
  });
  app.put('/accounts/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    const body = accountSchema.pick({ name: true, holder: true, bank: true, last4: true, remark: true }).partial().extend({ status: z.enum(['ACTIVE', 'DISABLED']).optional() }).parse(req.body);
    await app.write((tx) => updateAccount(tx, id, body, req.actor));
    return { ok: true };
  });

  // ---- 项目
  app.post('/projects', write, async (req) => {
    const body = projectSchema.parse(req.body);
    if (body.status === 'CLOSED') throw badRequest('新建项目不能直接为已结项');
    return { id: await app.write((tx) => createProject(tx, body, req.actor)) };
  });
  app.put('/projects/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    const body = projectSchema.partial().parse(req.body);
    await app.write((tx) => updateProject(tx, id, body, req.actor));
    return { ok: true };
  });
  app.get('/projects/:id/close-checks', read, async (req) => {
    const { id } = req.params as { id: string };
    return app.sql.begin((tx) => projectCloseChecks(tx, id));
  });
  app.post('/projects/:id/close', write, async (req) => {
    const { id } = req.params as { id: string };
    const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
    if (force && req.actor.role !== 'ADMIN') throw badRequest('只有管理员可以强制结项');
    await app.write((tx) => closeProject(tx, id, req.actor, force));
    return { ok: true };
  });
  app.post('/projects/:id/reopen', admin, async (req) => {
    const { id } = req.params as { id: string };
    await app.write(async (tx) => {
      const [p] = await tx`UPDATE project SET status = 'ACTIVE', closed_at = NULL WHERE id = ${id} AND status = 'CLOSED' RETURNING name`;
      if (!p) throw badRequest('项目不是已结项状态');
      await audit(tx, req.actor, 'project.reopen', 'PROJECT', id, `项目 ${p.name} 重新开启`);
    });
    return { ok: true };
  });

  // ---- 发票
  app.post('/invoices', write, async (req) => ({ id: await app.write((tx) => saveInvoice(tx, undefined, invoiceSchema.parse(req.body), req.actor)) }));
  app.put('/invoices/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    await app.write((tx) => saveInvoice(tx, id, invoiceSchema.parse(req.body), req.actor));
    return { ok: true };
  });
  app.delete('/invoices/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    await app.write((tx) => deleteInvoice(tx, id, req.actor));
    return { ok: true };
  });

  // ---- 会计期间：结账（财务）、反结账（管理员）
  app.post('/periods/close', write, async (req) => {
    const body = z.object({ entityIds: z.array(z.string()).min(1), period: z.string() }).parse(req.body);
    await app.write(async (tx) => {
      for (const e of body.entityIds) await setPeriod(tx, e, body.period, 'CLOSED', req.actor);
    });
    return { ok: true };
  });
  app.post('/periods/reopen', admin, async (req) => {
    const body = z.object({ entityId: z.string(), period: z.string() }).parse(req.body);
    await app.write((tx) => setPeriod(tx, body.entityId, body.period, 'OPEN', req.actor));
    return { ok: true };
  });

  // ---- 字典（管理员维护）
  app.post('/categories', admin, async (req) => {
    const body = z.object({ id: z.string().regex(/^c-[a-z0-9-]+$/, '编码格式如 c-mat-steel'), parentId: z.string(), name: z.string().trim().min(1) }).parse(req.body);
    await app.write(async (tx) => {
      const [p] = await tx`SELECT * FROM category WHERE id = ${body.parentId} AND parent_id IS NULL`;
      if (!p) throw badRequest('上级类型须为一级类型');
      await tx`INSERT INTO category (id, parent_id, name, nature, affects_pnl, requires_tax, sort) VALUES (${body.id}, ${p.id}, ${body.name}, ${p.nature}, ${p.affects_pnl}, ${p.requires_tax}, ${p.sort})`;
      await audit(tx, req.actor, 'category.create', 'CATEGORY', body.id, `新增账目类型 ${p.name}/${body.name}`);
    });
    return { ok: true };
  });
  app.post('/tax-rules', admin, async (req) => {
    const body = z.object({
      tax: z.string(), name: z.string().min(1), taxpayer: z.enum(['GENERAL', 'SMALL']).optional(), method: z.enum(['GENERAL', 'SIMPLE']).optional(), rate: z.number().min(0).max(0.99),
      thresholdAmount: cents.optional(), thresholdPeriod: z.enum(['MONTH', 'QUARTER']).optional(), validFrom: date, validTo: date.optional(), policyRef: z.string().optional(),
    }).parse(req.body);
    await app.write(async (tx) => {
      await tx`INSERT INTO tax_rule (tax, name, taxpayer, method, rate, threshold_amount, threshold_period, valid_from, valid_to, policy_ref)
               VALUES (${body.tax}, ${body.name}, ${body.taxpayer ?? null}, ${body.method ?? null}, ${body.rate}, ${body.thresholdAmount === undefined ? null : (body.thresholdAmount / 100).toFixed(2)},
                       ${body.thresholdPeriod ?? null}, ${body.validFrom}, ${body.validTo ?? null}, ${body.policyRef ?? null})`;
      await audit(tx, req.actor, 'taxRule.create', 'TAX_RULE', null, `新增税务规则 ${body.name}`);
    });
    return { ok: true };
  });
}
