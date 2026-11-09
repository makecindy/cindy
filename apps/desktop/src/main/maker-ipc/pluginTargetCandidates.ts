import { and, count, desc, eq, inArray, isNull, like, ne, or } from 'drizzle-orm';
import path from 'node:path';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs.js';
import { resolveBotCanonicalSession } from './botCanonicalSessionRegistry.js';
import { getReceivedSharesSnapshot } from '../device-link/providerShareGuest.js';
import { PROVIDER_SHARE_AGENT_DEVICE_PREFIX } from '../../shared/providerShare.js';
import type { PluginTargetCandidate, PluginTargetKind } from '../../shared/pluginTargets.js';

export async function listPluginTargetCandidates(
  kind: PluginTargetKind,
): Promise<PluginTargetCandidate[]> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw new Error('HOST_NOT_READY');
  const db = snapshot.client.drizzle;
  let result: PluginTargetCandidate[];
  if (kind === 'project') {
    result = (await listRecentWorkdirs(snapshot.client))
      .filter((row) => row.exists)
      .map((row) => ({
        id: row.path,
        label: path.basename(row.path) || row.path,
        detail: row.path,
      }));
  } else if (kind === 'bot') {
    const rows = await db
      .select({
        id: botProfiles.id,
        label: botProfiles.displayName,
        detail: botProfiles.description,
        agentDeviceId: sessions.agentDeviceId,
      })
      .from(botProfiles)
      .innerJoin(
        botSessionLinks,
        and(
          eq(botSessionLinks.botId, botProfiles.id),
          eq(botSessionLinks.role, 'canonical'),
          isNull(botSessionLinks.archivedAt),
        ),
      )
      .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
      .where(
        and(
          eq(botProfiles.status, 'active'),
          isNull(botProfiles.hiddenAt),
          eq(sessions.status, 'active'),
          isNull(sessions.hiddenAt),
          isNull(sessions.remoteHostId),
          or(isNull(sessions.agentDeviceId), like(sessions.agentDeviceId, `${PROVIDER_SHARE_AGENT_DEVICE_PREFIX}%`)),
        ),
      )
      .orderBy(desc(sessions.userSendAt), desc(sessions.updatedAt));
    // Count the authoritative links before route/visibility filtering: a second
    // remote or missing Session is still an ambiguous canonical registration.
    const registrations = rows.length ? await db
      .select({ id: botSessionLinks.botId, count: count() })
      .from(botSessionLinks)
      .where(and(inArray(botSessionLinks.botId, rows.map((row) => row.id)),
        eq(botSessionLinks.role, 'canonical'), isNull(botSessionLinks.archivedAt)))
      .groupBy(botSessionLinks.botId) : [];
    const counts = new Map(registrations.map((row) => [row.id, row.count]));
    // A received provider share runs the Agent elsewhere, but the companion
    // Session still belongs to this Host. Use only this owner's active shares;
    // the existing send/queue guards re-read these candidates before dispatch.
    const shares = getReceivedSharesSnapshot();
    const sharedRoutes = new Set(shares.active && shares.ownerStamp.dataOwnerId === snapshot.userId
      ? shares.received.filter((share) => share.status === 'active')
        .map((share) => `${PROVIDER_SHARE_AGENT_DEVICE_PREFIX}${share.shareId}`)
      : []);
    result = rows.filter((row) => counts.get(row.id) === 1
      && (row.agentDeviceId === null || sharedRoutes.has(row.agentDeviceId)))
      .map(({ id, label, detail }) => ({ id, label, detail }));
  } else {
    const rows = await db
      .select({ id: sessions.id, label: sessions.title, detail: sessions.workingDir })
      .from(sessions)
      .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
      .where(
        and(
          eq(sessions.status, 'active'),
          isNull(sessions.remoteHostId),
          isNull(sessions.agentDeviceId),
          isNull(sessions.hiddenAt),
          isNull(botSessionLinks.id),
          ne(sessions.source, 'bot'),
          ne(sessions.source, 'review'),
          or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker')),
        ),
      )
      .orderBy(desc(sessions.userSendAt), desc(sessions.updatedAt));
    result = rows.map((row) => ({ ...row, detail: row.detail || '' }));
  }
  if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('PERMISSION_DENIED');
  return result;
}
export async function resolvePluginTargetSession(
  kind: 'task' | 'bot',
  id: string,
): Promise<string> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw new Error('HOST_NOT_READY');
  if (!(await listPluginTargetCandidates(kind)).some((row) => row.id === id))
    throw new Error('TARGET_UNAVAILABLE');
  if (kind === 'task') return id;
  const canonical = await resolveBotCanonicalSession(id);
  if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('PERMISSION_DENIED');
  if (canonical.status !== 'resolved') throw new Error('TARGET_UNAVAILABLE');
  return canonical.sessionId;
}
