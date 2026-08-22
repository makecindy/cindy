/**
 * Detached 侧栏 pin 到非焦点 session 时，从会话表取主进程能权威给出的宿主上下文。
 * device-link 归属只存在 renderer 内存，这里刻意不写成 null（已确认本机）。
 */
import { eq } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import type { RsbWindowContext } from '../../shared/rightSidebarWindow.js';

export async function resolveRsbHostContextFromSession(
  sessionId: string,
): Promise<RsbWindowContext | null> {
  if (!sessionId) return null;
  try {
    const rows = await getDbClient()
      .drizzle.select({
        id: sessions.id,
        workingDir: sessions.workingDir,
        remoteHostId: sessions.remoteHostId,
        agentKind: sessions.agentKind,
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const row = rows[0];
    if (!row || row.status === 'deleted') return null;
    return {
      sessionId: row.id,
      workdir: row.workingDir ?? null,
      remoteHostId: row.remoteHostId ?? null,
      available: true,
      subagentsAvailable: row.agentKind === 'pi',
    };
  } catch {
    // DB 未就绪或读失败时退回调用方的 last-resort identity，不阻断开页。
    return null;
  }
}
