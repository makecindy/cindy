import { eq } from 'drizzle-orm';
import type { ToolCallAuthorizer } from '@cindy/mcps';
import type { DbClient } from '../localDb/client/DbClient.js';
import { sessions } from '../localDb/schema.js';

/** Correctness at the Host boundary. Tool permissions belong to the Agent runtime. */
export function createTaskToolCallAuthorizer(deps: {
  getDb(): Pick<DbClient, 'drizzle'> | null;
  isScopeCurrent(db: Pick<DbClient, 'drizzle'>): boolean;
}): ToolCallAuthorizer {
  return async ({ sessionId }) => {
    if (!sessionId) return { ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE', message: '无法识别调用任务。' };
    const db = deps.getDb();
    if (!db) return { ok: false, errorCode: 'HOST_NOT_READY', message: '任务数据尚未就绪。' };
    const [task] = await db.drizzle.select({ status: sessions.status }).from(sessions)
      .where(eq(sessions.id, sessionId)).limit(1);
    if (!deps.isScopeCurrent(db)) return { ok: false, errorCode: 'OWNER_SCOPE_CHANGED', message: '账号正在切换，请重试。' };
    // Archive changes list visibility; an already-running turn may still finish.
    if (!task || (task.status !== 'active' && task.status !== 'archived'))
      return { ok: false, errorCode: 'TASK_UNAVAILABLE', message: '调用任务已删除或不存在。' };
    return { ok: true };
  };
}
