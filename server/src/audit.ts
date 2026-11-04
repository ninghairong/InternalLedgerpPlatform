import type { Db } from './db';

export interface Actor {
  id: string;
  username: string;
  displayName: string;
  role: 'ADMIN' | 'FINANCE' | 'READONLY';
  ip?: string;
}

/** 审计日志与业务写入在同一事务中，失败一起回滚 */
export async function audit(db: Db, actor: Actor | undefined, action: string, targetType: string, targetId: string | number | null, summary: string, detail?: unknown) {
  await db`
    INSERT INTO audit_log(user_id, username, ip, action, target_type, target_id, summary, detail)
    VALUES (${actor?.id ?? null}, ${actor?.displayName ?? 'system'}, ${actor?.ip ?? null}, ${action}, ${targetType}, ${targetId === null ? null : String(targetId)}, ${summary}, ${detail === undefined ? null : (detail as never)})`;
}
