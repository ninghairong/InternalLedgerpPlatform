import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { Role } from '@ledger/shared/types';
import { config } from './config';
import type { Sql, Tx } from './db';
import type { Actor } from './audit';
import { AppError, forbidden, fromDbError } from './errors';
import { invalidate } from './snapshot';
import authRoutes from './routes/auth';
import dataRoutes from './routes/data';
import flowRoutes from './routes/flows';
import importRoutes from './routes/imports';
import exportRoutes from './routes/exports';
import adminRoutes from './routes/admin';

declare module 'fastify' {
  interface FastifyInstance {
    sql: Sql;
    /** 写操作：事务 + 提交后使读缓存失效 */
    write: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
    auth: (roles?: Role[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    actor: Actor;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; v: number };
  }
}

export const WRITE_ROLES: Role[] = ['ADMIN', 'FINANCE'];
export const ADMIN_ONLY: Role[] = ['ADMIN'];

export async function buildApp(sql: Sql, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024, trustProxy: true });
  app.decorate('sql', sql);
  app.decorate('write', async <T>(fn: (tx: Tx) => Promise<T>) => {
    const r = await sql.begin(fn);
    invalidate();
    return r as T;
  });
  app.decorateRequest('actor', null as unknown as Actor);

  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: config.jwtExpiresIn } });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 20 } });

  app.decorate('auth', (roles?: Role[]) => async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', '请先登录');
    }
    const [u] = await sql`SELECT id::text, username, display_name, role, status FROM app_user WHERE id = ${req.user.sub}`;
    if (!u || u.status !== 'ACTIVE') throw new AppError(401, 'UNAUTHORIZED', '账号不存在或已停用');
    req.actor = { id: u.id, username: u.username, displayName: u.display_name, role: u.role, ip: req.ip };
    if (roles && !roles.includes(u.role)) throw forbidden(u.role === 'READONLY' ? '只读账号不能修改数据' : '只有管理员可以执行此操作');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ code: err.code, message: err.message, details: err.details });
    if (err instanceof ZodError) {
      const msg = err.issues.map((i) => `${i.path.join('.') || '参数'}：${i.message}`).join('；');
      return reply.status(400).send({ code: 'VALIDATION', message: `参数错误：${msg}`, details: err.issues });
    }
    const dbErr = fromDbError(err);
    if (dbErr) return reply.status(dbErr.status).send({ code: dbErr.code, message: dbErr.message });
    const e = err as { statusCode?: number; message: string; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ code: e.code ?? 'BAD_REQUEST', message: e.code === 'FST_REQ_FILE_TOO_LARGE' ? '文件超过 20MB' : e.message });
    req.log.error(err);
    return reply.status(500).send({ code: 'INTERNAL', message: '服务器内部错误，请稍后重试或联系管理员' });
  });

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(dataRoutes, { prefix: '/api' });
  await app.register(flowRoutes, { prefix: '/api' });
  await app.register(importRoutes, { prefix: '/api' });
  await app.register(exportRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });
  app.get('/api/health', async () => ({ ok: true }));

  // 部署时由同一进程提供前端页面（前端路由回退到 index.html）
  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ code: 'NOT_FOUND', message: '接口不存在' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}

/** 下载响应：中文文件名按 RFC 5987 编码 */
export function sendFile(reply: FastifyReply, fileName: string, buffer: Buffer, mime: string) {
  return reply
    .header('Content-Type', mime)
    .header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    .send(buffer);
}
