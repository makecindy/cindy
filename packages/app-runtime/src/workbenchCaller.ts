import {and,eq} from 'drizzle-orm';
import type {DbClient} from '@cindy/runtime-db';
import {botProfiles,botSessionLinks,sessions} from '@cindy/runtime-db/schema';
export type WorkbenchCallerResult={ok:true;botId:string}|{ok:false;errorCode:string;message:string};
export function createWorkbenchCaller(getDbClient:()=>DbClient) {
async function resolveWorkbenchCaller(callerSessionId: string): Promise<WorkbenchCallerResult> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      botId: botSessionLinks.botId,
      role: botSessionLinks.role,
      sessionStatus: sessions.status,
      remoteHostId: sessions.remoteHostId,
      profileStatus: botProfiles.status,
      linkArchivedAt: botSessionLinks.archivedAt,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(and(eq(botSessionLinks.sessionId, callerSessionId), eq(sessions.source, 'bot')))
    .limit(1);
  if (!row) return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于任何伙伴' };
  if (row.sessionStatus !== 'active' || row.profileStatus !== 'active' || row.linkArchivedAt !== null) {
    return { ok: false, errorCode: 'BOT_SESSION_INACTIVE', message: '伙伴或它的主任务已停用' };
  }
  if (row.role !== 'canonical' && row.role !== 'thread') {
    return { ok: false, errorCode: 'BOT_MAIN_TASK_REQUIRED', message: '只有伙伴的主任务可以使用工作台' };
  }
  if (row.remoteHostId) {
    return { ok: false, errorCode: 'REMOTE_WORKBENCH_UNAVAILABLE', message: '远端伙伴暂不支持工作台' };
  }
  return { ok: true, botId: row.botId };
}

return {resolveWorkbenchCaller};
}
