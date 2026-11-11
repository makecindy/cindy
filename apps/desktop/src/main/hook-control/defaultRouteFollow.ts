import { and, eq, isNull } from 'drizzle-orm';

import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getDbClient } from '../localDb/client/current';
import { sessions } from '../localDb/schema';
import { buildImDefaultRouteRecord, parseImDefaultRouteRecord } from '../im/shared/channelDefaultRoute.js';
import type { SessionRouteRow } from '../im/shared/channelDefaultRouteSync.js';

const HOOK_FINGERPRINT_PREFIX = '["hook",';

/**
 * 官方任务的创建记录有两种指纹：显式默认直接是 `["hook",…]`；默认模型为空、自动选模时，
 * resolvedImDefaultFingerprint 会把它作为第一项再包一层 `[<上面的串>, agent, model, …]`。
 * 两种都是官方任务自己写下的记录，只认前一种会让自动选模建出的任务永远不跟随默认变化。
 */
function isHookFingerprint(fp: string): boolean {
  if (fp.startsWith(HOOK_FINGERPRINT_PREFIX)) return true;
  try {
    const outer: unknown = JSON.parse(fp);
    return Array.isArray(outer) && typeof outer[0] === 'string'
      && outer[0].startsWith(HOOK_FINGERPRINT_PREFIX);
  } catch {
    return false;
  }
}

/** 只跟随有创建记录的官方任务；历史任务和被接管的桌面任务不按值猜测。 */
export function isHookDefaultRouteRow(row: SessionRouteRow): boolean {
  const record = parseImDefaultRouteRecord(row.imDefaultRoute);
  return row.status === 'active' && !row.remoteHostId && !row.orcaRole && !!row.model
    && !row.imBotContextId && !row.feishuBotAppId
    && record !== null && isHookFingerprint(record.fp);
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
