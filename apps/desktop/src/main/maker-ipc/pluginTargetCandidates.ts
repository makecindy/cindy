import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';
import path from 'node:path';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs.js';
import { resolveBotCanonicalSession } from './botCanonicalSessionRegistry.js';
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
          isNull(sessions.remoteHostId),
          isNull(sessions.agentDeviceId),
        ),
      )
      .orderBy(desc(sessions.userSendAt), desc(sessions.updatedAt));
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    result = rows.filter((row) => counts.get(row.id) === 1);
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
  if (!(await listPluginTargetCandidates(kind)).some((row) => row.id === id))
    throw new Error('TARGET_UNAVAILABLE');
  if (kind === 'task') return id;
  const canonical = await resolveBotCanonicalSession(id);
  if (canonical.status !== 'resolved') throw new Error('TARGET_UNAVAILABLE');
  return canonical.sessionId;
}
