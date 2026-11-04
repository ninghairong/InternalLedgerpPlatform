import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TEMPLATES, TEMPLATE_NAMES, XLSX_MIME, type TemplateCode } from '@ledger/shared/excel';
import { today } from '@ledger/shared/format';
import { sendFile, WRITE_ROLES } from '../app';
import { badRequest } from '../errors';
import { buildTemplateFile } from '../services/exports';
import { commitImport, getImport, revalidateImport, rollbackImport, uploadImport, type UploadedFile } from '../services/imports';

export default async function importRoutes(app: FastifyInstance) {
  const read = { preHandler: app.auth() };
  const write = { preHandler: app.auth(WRITE_ROLES) };

  app.get('/templates/:code', read, async (req, reply) => {
    const { code } = req.params as { code: string };
    if (!(code in TEMPLATES)) throw badRequest('未知模板');
    const q = z.object({ accountId: z.string().optional(), fill: z.string().optional() }).parse(req.query);
    const buf = await buildTemplateFile(app.sql, code as TemplateCode, { accountId: q.accountId, fill: q.fill === '1' });
    return sendFile(reply, `${TEMPLATE_NAMES[code as TemplateCode]}${q.fill === '1' ? '_现有数据' : '模板'}_${today()}.xlsx`, buf, XLSX_MIME);
  });

  /** 上传一个或多个 .xlsx，返回逐行校验结果（尚未入账） */
  app.post('/imports', write, async (req) => {
    const files: UploadedFile[] = [];
    for await (const part of req.files()) files.push({ name: part.filename, data: await part.toBuffer(), mime: part.mimetype });
    return uploadImport(app.sql, files, req.actor);
  });

  app.get('/imports/:id', read, async (req) => getImport(app.sql, (req.params as { id: string }).id));

  app.post('/imports/:id/validate', write, async (req) => {
    const { skip } = z.object({ skip: z.array(z.string()).default([]) }).parse(req.body ?? {});
    return revalidateImport(app.sql, (req.params as { id: string }).id, skip);
  });

  app.post('/imports/:id/commit', write, async (req) => commitImport(app.sql, (req.params as { id: string }).id, req.actor));

  app.post('/imports/:id/rollback', write, async (req) => rollbackImport(app.sql, (req.params as { id: string }).id, req.actor));
}
