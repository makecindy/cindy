import { isCompanionShadowed } from '../companion-cloud/homes';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current';
import { botProfiles, sessions } from '../localDb/schema';
import { ensureBotChannelLaneSession } from '../localDb/ipc/bots';
import { captureChannelAccount } from '../im/shared/openChannelSession';
import { throwIpcError } from '../utils/ipcValidate';

/** The official X transport already authenticates the connected principal. */
export async function requireXCompanion(botId: string): Promise<void> {
  const [profile] = await getDbClient().drizzle.select({ status: botProfiles.status })
    .from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
  if (profile?.status !== 'active' || isCompanionShadowed(botId)) throwIpcError('INVALID_PARAMS', 'Companion is unavailable');
}

export async function resolveXCompanionTarget(botId: string, externalKey: string) {
  const assertAccount = captureChannelAccount();
  await requireXCompanion(botId);
  assertAccount();
  // Public threads never reuse the private canonical conversation. Hash the full
  // transport key (including its principal/thread scope), not a truncated tweet id.
  const key = createHash('sha256').update(externalKey).digest('hex');
  const lane = await ensureBotChannelLaneSession({ botId, routeKey: `im:x:official:${key}`, title: 'X' });
  if (!lane.ok) throw new Error(lane.message);
  assertAccount();
  const [row] = await getDbClient().drizzle.select({ workingDir: sessions.workingDir })
    .from(sessions).where(eq(sessions.id, lane.sessionId)).limit(1);
  assertAccount();
  if (!row?.workingDir) throw new Error('Companion workspace is unavailable');
  return { sessionId: lane.sessionId, workingDir: row.workingDir };
}
