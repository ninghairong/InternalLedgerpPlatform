import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ADMIN_ONLY, sendFile } from '../app';
import { backupPath, createBackup, listBackups, selfCheck } from '../services/system';
import { createUser, updateUser } from '../services/master';

const role = z.enum(['ADMIN', 'FINANCE', 'READONLY']);

export default async function adminRoutes(app: FastifyInstance) {
  const read = { preHandler: app.auth() };
  const admin = { preHandler: app.auth(ADMIN_ONLY) };

  app.get('/users', admin, async () => {
    const rows = await app.sql`SELECT id::text, username, display_name, role, status, last_login_at FROM app_user ORDER BY id`;
    return rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, status: u.status, lastLoginAt: u.last_login_at ? new Date(u.last_login_at).toISOString() : undefined }));
  });
  app.post('/users', admin, async (req) => {
    const body = z.object({ username: z.string().trim().min(2).regex(/^[a-zA-Z0-9_.-]+$/, '用户名只能包含字母、数字、. _ -'), displayName: z.string().trim().min(1), role, password: z.string().min(8, '密码至少 8 位') }).parse(req.body);
    return { id: await app.write((tx) => createUser(tx, body, req.actor)) };
  });
  app.put('/users/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ displayName: z.string().trim().min(1).optional(), role: role.optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), password: z.string().min(8, '密码至少 8 位').optional() }).parse(req.body);
    await app.write((tx) => updateUser(tx, id, body, req.actor));
    return { ok: true };
  });

  /** 审计日志（所有人可查，便于对账时追溯） */
  app.get('/audit', read, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), action: z.string().optional(), targetType: z.string().optional(), targetId: z.string().optional() }).parse(req.query);
    const rows = await app.sql`
      SELECT id::text, at, username, action, target_type, target_id, summary FROM audit_log
       WHERE (${q.action ?? null}::text IS NULL OR action LIKE ${`${q.action ?? ''}%`})
         AND (${q.targetType ?? null}::text IS NULL OR target_type = ${q.targetType ?? ''})
         AND (${q.targetId ?? null}::text IS NULL OR target_id = ${q.targetId ?? ''})
       ORDER BY id DESC LIMIT ${q.limit}`;
    return rows.map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), user: r.username, action: r.action, targetType: r.target_type, targetId: r.target_id ?? undefined, summary: r.summary ?? undefined }));
  });

  app.get('/admin/self-check', read, async () => selfCheck(app.sql));

  app.get('/admin/backups', admin, async () => listBackups());
  app.post('/admin/backups', admin, async (req) => ({ name: await createBackup(app.sql, req.actor) }));
  app.get('/admin/backups/:name', admin, async (req, reply) => {
    const p = backupPath((req.params as { name: string }).name);
    return sendFile(reply, (req.params as { name: string }).name, await fs.readFile(p), 'application/octet-stream');
  });
}
