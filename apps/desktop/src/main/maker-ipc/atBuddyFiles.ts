import { and, eq, inArray, isNull } from 'drizzle-orm';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { isSensitiveCredentialPath, scanWorkspaceFileResources, type AtResourceItem } from '@cindy/maker-core';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import { readSessionExtraDirsFromDb } from '../maker-host/session-storage.js';
import { extractDisplayName } from '../../shared/projectDisplayName.js';
import { botProfileDir } from './botProfileFolder.js';
import { linkedProjectDirectoryKey, readBotLinkedProjects } from './botLinkedProjectStore.js';
import { splitExtraDirSlots, validateExtraDirs } from './extraDirsValidator.js';

interface AtBuddyFile extends AtResourceItem {
  sourceLabel: string;
  sourceRelativePath: string;
}

const MAX_VISITED_DIRECTORIES = 512;
const MAX_RESULTS_PER_ROOT = 32;
const empty = { items: [] as AtBuddyFile[], truncated: false };

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Supplemental search for the owner's local buddy chat. The session row and
 * its saved links supply all roots. The caller only identifies the active task. */
export async function scanAtBuddyFiles(
  request: { sessionId: string; workingDir: string; query: string },
  signal: AbortSignal,
): Promise<{ items: AtBuddyFile[]; truncated: boolean }> {
  const owner = activeOwnerScopeKey();
  const db = getCurrentDbClientSnapshot();
  const isCurrent = () => !signal.aborted && !isAppSessionBoundaryPending()
    && activeOwnerScopeKey() === owner && getCurrentDbClientSnapshot() === db;
  if (!db || !getActiveAppSession().dataOwnerId || !isCurrent()) return empty;
  const ownerRoot = ownerScopedUserDataPath();
  const [session] = await db.client.drizzle
    .select({ botId: botSessionLinks.botId, workingDir: sessions.workingDir })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(and(
      eq(botSessionLinks.sessionId, request.sessionId),
      inArray(botSessionLinks.role, ['canonical', 'thread']),
      isNull(botSessionLinks.archivedAt),
      eq(botProfiles.status, 'active'),
      eq(sessions.source, 'bot'),
      eq(sessions.status, 'active'),
      // The workspace stays local even when the model runs on another computer.
      isNull(sessions.remoteHostId),
    ))
    .limit(1);
  if (!session?.workingDir || !isCurrent()) return empty;
  const workdir = linkedProjectDirectoryKey(session.workingDir);
  const workspace = path.join(botProfileDir(ownerRoot, session.botId), 'workspace');
  if (workdir !== linkedProjectDirectoryKey(request.workingDir)
    || workdir !== linkedProjectDirectoryKey(workspace)) return empty;

  const [projects, savedDirs] = await Promise.all([
    readBotLinkedProjects(ownerRoot, session.botId).catch(() => []),
    readSessionExtraDirsFromDb(request.sessionId).catch(() => []),
  ]);
  if (!isCurrent()) return empty;
  const { valid } = await validateExtraDirs(splitExtraDirSlots(savedDirs).user, session.workingDir);
  if (!isCurrent()) return empty;
  const roots = new Map<string, string>();
  for (const directory of [...projects.filter(project => !project.deviceId).map(project => project.path), ...valid]) {
    const absolute = path.resolve(directory);
    if (isWithin(session.workingDir, absolute) || isSensitiveCredentialPath(absolute)) continue;
    roots.set(linkedProjectDirectoryKey(absolute), absolute);
  }
  if (!roots.size) return empty;
  const labels = [...roots.values()].map(root => root.split(path.sep).join('/'));
  const [actualWorkingDir, actualOwnerRoot] = await Promise.all([
    realpath(session.workingDir).catch(() => null),
    realpath(ownerRoot).catch(() => null),
  ]);
  if (!actualOwnerRoot || !isCurrent()) return empty;
  const ownersRoot = path.dirname(actualOwnerRoot);
  const canSearch = (candidate: string) => !isSensitiveCredentialPath(candidate)
    && (!isWithin(ownersRoot, candidate) || isWithin(actualOwnerRoot, candidate))
    && (!actualWorkingDir || !isWithin(actualWorkingDir, candidate));
  const scannedRoots = new Set<string>();
  const budget = Math.max(1, Math.floor(MAX_VISITED_DIRECTORIES / roots.size));
  const files = new Map<string, AtBuddyFile>();
  let truncated = false;
  for (const root of roots.values()) {
    if (!isCurrent()) return empty;
    // Match the project picker: directory aliases are allowed when their target
    // passes the same owner and sensitive-path checks as an ordinary directory.
    const actualRoot = await realpath(root).catch(() => null);
    if (!actualRoot || !isCurrent() || !canSearch(actualRoot)) continue;
    const actualKey = linkedProjectDirectoryKey(actualRoot);
    if (scannedRoots.has(actualKey)) continue;
    scannedRoots.add(actualKey);
    const result = await scanWorkspaceFileResources(actualRoot, MAX_RESULTS_PER_ROOT, {
      query: request.query,
      maxDirectories: budget,
      includeDirectories: false,
      includePath: canSearch,
      shouldContinue: isCurrent,
    }).catch(() => null);
    if (!result) continue;
    const sourceLabel = extractDisplayName(root.split(path.sep).join('/'), labels).name;
    truncated ||= result.truncated;
    for (const item of result.items) {
      if (item.type !== 'file') continue;
      const absolute = path.join(root, item.relPath);
      if (isSensitiveCredentialPath(absolute)) continue;
      const key = linkedProjectDirectoryKey(path.join(actualRoot, item.relPath));
      if (!files.has(key)) files.set(key, { ...item, relPath: absolute, sourceLabel, sourceRelativePath: item.relPath });
    }
  }
  return isCurrent() ? { items: [...files.values()], truncated } : empty;
}
