import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';
import path from 'node:path';
import { isTeammateProjectPath } from '@cindy/maker-shared/teammate-project';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs.js';
import { listProjectAliases } from '../localDb/ipc/projectAliases.js';
import { projectKeyComparisonKey } from '../../shared/projectKeys.js';
import { resolveBotCanonicalSession } from './botCanonicalSessionRegistry.js';
import type { PluginTargetCandidate, PluginTargetKind, PluginTargetRef } from '../../shared/pluginTargets.js';

export async function listPluginTargetCandidates(
  kind: PluginTargetKind,
): Promise<PluginTargetCandidate[]> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw new Error('HOST_NOT_READY');
  const db = snapshot.client.drizzle;
  let result: PluginTargetCandidate[];
  if (kind === 'project') {
    const [workdirs, aliasRows] = await Promise.all([
      listRecentWorkdirs(snapshot.client),
      listProjectAliases(snapshot.client).catch(() => []),
    ]);
    const aliases = new Map<string | null, string>();
    // Rows are newest first. Preserve the newest alias when Windows keys differ only in case.
    for (const row of aliasRows) {
      const key = projectKeyComparisonKey(row.projectKey, process.platform);
      if (key && !aliases.has(key)) aliases.set(key, row.alias);
    }
    result = workdirs
      // Teammates are offered as their own kind; their project is not a second entry.
      .filter((row) => row.exists && !isTeammateProjectPath(row.path))
      .map((row) => {
        const key = projectKeyComparisonKey(`local:${row.path}`, process.platform);
        const alias = aliases.get(key);
        return {
          id: row.path,
          label: alias || path.basename(row.path) || row.path,
          detail: row.path,
          ...(alias ? { alias } : {}),
        };
      });
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
    // A task whose Agent runs on another computer or a shared provider (agentDeviceId) still keeps
    // its record, files and permissions on this computer, so it is a local task here. SSH tasks are not.
    const rows = await db
      .select({ id: sessions.id, label: sessions.title, detail: sessions.workingDir })
      .from(sessions)
      .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
      .where(
        and(
          eq(sessions.status, 'active'),
          isNull(sessions.remoteHostId),
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

/** Reverse only the authoritative canonical link; other companion sessions are not targets. */
export async function resolvePluginSessionTarget(sessionId: string): Promise<PluginTargetRef> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw new Error('HOST_NOT_READY');
  const links = await snapshot.client.drizzle
    .select({ botId: botSessionLinks.botId, role: botSessionLinks.role, archivedAt: botSessionLinks.archivedAt })
    .from(botSessionLinks)
    .where(eq(botSessionLinks.sessionId, sessionId))
    .limit(2);
  if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('PERMISSION_DENIED');
  if (links.length === 0) return { kind: 'task', id: sessionId };
  const link = links[0]!;
  if (links.length !== 1 || link.role !== 'canonical' || link.archivedAt !== null)
    throw new Error('TARGET_UNAVAILABLE');
  const canonical = await resolveBotCanonicalSession(link.botId);
  if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('PERMISSION_DENIED');
  if (canonical.status !== 'resolved' || canonical.sessionId !== sessionId)
    throw new Error('TARGET_UNAVAILABLE');
  return { kind: 'bot', id: link.botId };
}
