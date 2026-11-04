import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { XLSX_MIME } from '@ledger/shared/excel';
import { sendFile } from '../app';
import { runExport } from '../services/exports';

export default async function exportRoutes(app: FastifyInstance) {
  app.get('/exports/:kind', { preHandler: app.auth() }, async (req, reply) => {
    const { kind } = req.params as { kind: string };
    const q = z.object({ entityId: z.string().optional(), accountId: z.string().optional(), projectId: z.string().optional(), from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    const { fileName, buffer } = await runExport(app.sql, kind, q, req.actor);
    return sendFile(reply, fileName, buffer, XLSX_MIME);
  });

  /** 按页面当前筛选结果导出流水 */
  app.post('/exports/flows', { preHandler: app.auth() }, async (req, reply) => {
    const body = z.object({ ids: z.array(z.string()).max(100000), title: z.string().max(60).optional() }).parse(req.body);
    const { fileName, buffer } = await runExport(app.sql, 'flows', body, req.actor);
    return sendFile(reply, fileName, buffer, XLSX_MIME);
  });
}
