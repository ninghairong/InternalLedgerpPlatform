import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit';
import { AppError, badRequest } from '../errors';
import { verifyPassword } from '../password';
import { updateUser } from '../services/master';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export default async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req) => {
    const body = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const [u] = await app.sql`SELECT * FROM app_user WHERE username = ${body.username}`;
    if (!u || u.status !== 'ACTIVE') throw new AppError(401, 'LOGIN_FAILED', '用户名或密码错误');
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60000);
      throw new AppError(423, 'LOCKED', `连续输错密码，账号已锁定，请 ${mins} 分钟后再试`);
    }
    if (!(await verifyPassword(body.password, u.password_hash))) {
      const failed = u.failed_logins + 1;
      await app.sql`UPDATE app_user SET failed_logins = ${failed >= MAX_FAILED ? 0 : failed},
                      locked_until = ${failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000) : null} WHERE id = ${u.id}`;
      await audit(app.sql, undefined, 'auth.failed', 'USER', String(u.id), `${u.display_name} 登录失败（第 ${failed} 次）`);
      throw new AppError(401, 'LOGIN_FAILED', failed >= MAX_FAILED ? `密码错误次数过多，账号锁定 ${LOCK_MINUTES} 分钟` : `用户名或密码错误（还可尝试 ${MAX_FAILED - failed} 次）`);
    }
    await app.sql`UPDATE app_user SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = ${u.id}`;
    await audit(app.sql, { id: String(u.id), username: u.username, displayName: u.display_name, role: u.role, ip: req.ip }, 'auth.login', 'USER', String(u.id), `${u.display_name} 登录`);
    const token = app.jwt.sign({ sub: String(u.id), v: u.version });
    return { token, user: { id: String(u.id), username: u.username, displayName: u.display_name, role: u.role } };
  });

  app.get('/auth/me', { preHandler: app.auth() }, async (req) => ({
    id: req.actor.id, username: req.actor.username, displayName: req.actor.displayName, role: req.actor.role,
  }));

  app.post('/auth/password', { preHandler: app.auth() }, async (req) => {
    const body = z.object({ oldPassword: z.string(), newPassword: z.string().min(8, '新密码至少 8 位') }).parse(req.body);
    const [u] = await app.sql`SELECT password_hash FROM app_user WHERE id = ${req.actor.id}`;
    if (!(await verifyPassword(body.oldPassword, u.password_hash))) throw badRequest('原密码不正确');
    await app.write((tx) => updateUser(tx, req.actor.id, { password: body.newPassword }, req.actor));
    return { ok: true };
  });
}
