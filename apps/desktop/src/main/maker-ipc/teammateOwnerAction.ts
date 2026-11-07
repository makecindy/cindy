import { and, eq, isNull } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { botProfileVersions, botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import { readChannelToolScope } from '../im/shared/channelToolScope.js';
import { readBotProjectMode } from '../../shared/botProjectMode.js';

const OWNER_CHAT_ROLES = new Set(['canonical', 'thread', 'routine']);

/**
 * The teammate a task acts for when it manages the owner's things (routines,
 * new teammates). The owner's own chats always qualify. A V2 teammate is one
 * project, so its IM lanes qualify too — but only on a turn the owner started:
 * who is speaking is checked by the host per turn, never left to the prompt.
 */
export async function resolveTeammateOwnerAction(
  callerSessionId: string,
  callerSessionInstanceId?: string,
): Promise<string | null> {
  const [row] = await getDbClient().drizzle
    .select({ botId: botSessionLinks.botId, role: botSessionLinks.role, config: botProfileVersions.capabilitiesJson })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .innerJoin(botProfileVersions, and(
      eq(botProfileVersions.botId, botProfiles.id),
      eq(botProfileVersions.version, botProfiles.currentVersion),
    ))
    .where(and(
      eq(botSessionLinks.sessionId, callerSessionId),
      eq(sessions.source, 'bot'),
      isNull(botSessionLinks.archivedAt),
    ))
    .limit(1);
  if (!row) return null;
  if (OWNER_CHAT_ROLES.has(row.role)) return row.botId;
  if (row.role !== 'channel') return null;
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(row.config) as Record<string, unknown>; } catch { return null; }
  if (!readBotProjectMode(config)) return null;
  const scope = readChannelToolScope({ sessionId: callerSessionId, sessionInstanceId: callerSessionInstanceId });
  return scope?.requesterIsOwner ? row.botId : null;
}
