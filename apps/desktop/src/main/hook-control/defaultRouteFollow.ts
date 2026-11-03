import { and, eq, isNull } from 'drizzle-orm';

import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getDbClient } from '../localDb/client/current';
import { sessions } from '../localDb/schema';
import { buildImDefaultRouteRecord, parseImDefaultRouteRecord } from '../im/shared/channelDefaultRoute.js';
import type { SessionRouteRow } from '../im/shared/channelDefaultRouteSync.js';

/** 只跟随有创建记录的官方任务；历史任务和被接管的桌面任务不按值猜测。 */
export function isHookDefaultRouteRow(row: SessionRouteRow): boolean {
  const record = parseImDefaultRouteRecord(row.imDefaultRoute);
  return row.status === 'active' && !row.remoteHostId && !row.orcaRole && !!row.model
    && !row.imBotContextId && !row.feishuBotAppId
    && record?.fp.startsWith('["hook",') === true;
}

/** 新任务记录实际落地路由；同值手动选择留下的记录也不能覆盖。 */
export async function writeHookDefaultRouteRecord(sessionId: string, fingerprint: string): Promise<void> {
  const db = getDbClient();
  const [row] = await db.drizzle
    .select({
      agentKind: sessions.agentKind,
      model: sessions.model,
      providerId: sessions.providerId,
      agentDeviceId: sessions.agentDeviceId,
      effort: sessions.effort,
      imDefaultRoute: sessions.imDefaultRoute,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row?.model || row.imDefaultRoute !== null) return;
  await db.drizzle
    .update(sessions)
    .set({
      imDefaultRoute: buildImDefaultRouteRecord(fingerprint, {
        agentKind: dbToMakerAgentKind(row.agentKind),
        model: row.model,
        providerId: row.providerId?.trim() || null,
        agentDeviceId: row.agentDeviceId ?? null,
        effort: row.effort ?? null,
      }),
    })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.imDefaultRoute)));
}
