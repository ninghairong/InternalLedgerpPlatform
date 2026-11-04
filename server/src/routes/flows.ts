import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { today } from '@ledger/shared/format';
import { sendFile, WRITE_ROLES } from '../app';
import { audit } from '../audit';
import { config } from '../config';
import { badRequest, notFound } from '../errors';
import { createFlows, reverseFlow, updateFlowInfo, writeoffLot } from '../services/flows';

const amount = z.number().int().positive('金额必须为正数');

export const flowInput = z.object({
  tempId: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount,
  fromAccountId: z.string(),
  toAccountId: z.string(),
  method: z.enum(['BANK_TRANSFER', 'CORPORATE_TRANSFER', 'WECHAT', 'ALIPAY', 'CASH_WITHDRAW', 'CASH_DEPOSIT', 'CASH_HANDOVER', 'OTHER']),
  bookSummary: z.string().optional(),
  actualPurpose: z.string().optional(),
  purposeMismatch: z.boolean().optional(),
  icNature: z.enum(['LOAN', 'REPAYMENT', 'ON_BEHALF', 'SERVICE_SETTLEMENT', 'FUND_ALLOCATION']).optional(),
  handler: z.string().optional(),
  bankSerialNo: z.string().optional(),
  invoiceNos: z.array(z.string()).optional(),
  remark: z.string().optional(),
  splits: z.array(z.object({
    projectId: z.string(),
    categoryId: z.string(),
    amount,
    tax: z.enum(['VAT', 'VAT_PREPAY', 'SURCHARGE', 'IIT', 'CIT', 'STAMP', 'SOCIAL']).optional(),
    taxPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/, '所属期格式应为 2026-10 或 2026-Q3').optional(),
  })).min(1),
  allocations: z.array(z.object({ lotFlowId: z.string(), amount, auto: z.boolean().default(false) })).default([]),
});

export default async function flowRoutes(app: FastifyInstance) {
  const read = { preHandler: app.auth() };
  const write = { preHandler: app.auth(WRITE_ROLES) };

  /** 新建一笔或多笔（连续流转）流水；多笔时后面的可以用 tempId 引用前面的作为资金来源 */
  app.post('/flows', write, async (req) => {
    const body = z.object({ flows: z.array(flowInput).min(1).max(200) }).parse(req.body);
    const { created } = await app.write((tx) => createFlows(tx, body.flows, req.actor));
    return { created };
  });

  app.post('/flows/:id/reverse', write, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().trim().min(1, '请填写冲销原因') }).parse(req.body);
    const flowNo = await app.write((tx) => reverseFlow(tx, id, reason, req.actor));
    return { flowNo };
  });

  app.patch('/flows/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ remark: z.string().optional(), actualPurpose: z.string().optional(), purposeMismatch: z.boolean().optional(), invoiceNos: z.array(z.string()).optional(), handler: z.string().optional() }).parse(req.body);
    await app.write((tx) => updateFlowInfo(tx, id, body, req.actor));
    return { ok: true };
  });

  /** 外部账户差额核销（如交给李老板 6 万只转回 5.8 万，差额 2000 说明为返点） */
  app.post('/lots/:flowId/writeoff', write, async (req) => {
    const { flowId } = req.params as { flowId: string };
    const body = z.object({ amount, categoryId: z.string(), reason: z.string().trim().min(1, '请说明差额原因') }).parse(req.body);
    await app.write((tx) => writeoffLot(tx, flowId, body.amount, body.categoryId, body.reason, req.actor));
    return { ok: true };
  });

  // ---- 凭证附件
  app.get('/flows/:id/attachments', read, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await app.sql`
      SELECT a.id::text, a.file_name, a.mime_type, a.size_bytes, a.uploaded_at, u.display_name
        FROM attachment_link l JOIN attachment a ON a.id = l.attachment_id LEFT JOIN app_user u ON u.id = a.uploaded_by
       WHERE l.target_type = 'FLOW' AND l.target_id = ${id} ORDER BY a.id`;
    return rows.map((r) => ({ id: r.id, fileName: r.file_name, mimeType: r.mime_type, size: Number(r.size_bytes), uploadedAt: new Date(r.uploaded_at).toISOString(), uploadedBy: r.display_name }));
  });

  app.post('/flows/:id/attachments', write, async (req) => {
    const { id } = req.params as { id: string };
    const [flow] = await app.sql`SELECT flow_no FROM flow WHERE id = ${id}`;
    if (!flow) throw notFound('流水');
    const saved: string[] = [];
    for await (const part of req.files()) {
      const data = await part.toBuffer();
      if (!/^(image\/|application\/pdf)/.test(part.mimetype)) throw badRequest('凭证只支持图片和 PDF');
      const sha = createHash('sha256').update(data).digest('hex');
      const key = path.join(today().slice(0, 7), `${randomUUID()}${path.extname(part.filename) || ''}`);
      await fs.mkdir(path.join(config.attachmentDir, path.dirname(key)), { recursive: true });
      await fs.writeFile(path.join(config.attachmentDir, key), data);
      await app.write(async (tx) => {
        const [a] = await tx`INSERT INTO attachment (storage_key, file_name, mime_type, size_bytes, sha256, uploaded_by) VALUES (${key}, ${part.filename}, ${part.mimetype}, ${data.length}, ${sha}, ${req.actor.id}) RETURNING id`;
        await tx`INSERT INTO attachment_link (attachment_id, target_type, target_id) VALUES (${a.id}, 'FLOW', ${id})`;
        await audit(tx, req.actor, 'attachment.upload', 'FLOW', id, `上传凭证 ${part.filename} 到 ${flow.flow_no}`);
      });
      saved.push(part.filename);
    }
    if (!saved.length) throw badRequest('没有收到文件');
    return { saved };
  });

  app.get('/attachments/:id', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [a] = await app.sql`SELECT * FROM attachment WHERE id = ${id}`;
    if (!a) throw notFound('附件');
    const data = await fs.readFile(path.join(config.attachmentDir, a.storage_key));
    if ((req.query as { inline?: string }).inline) return reply.header('Content-Type', a.mime_type).send(data);
    return sendFile(reply, a.file_name, data, a.mime_type);
  });
}
