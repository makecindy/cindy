import path from 'node:path';
import { validateProjectDirectories } from './projectDirectoryValidation.js';
import { sessionTaskProjectDirectory } from '@cindy/maker-shared/worktree-paths';
import { eq } from 'drizzle-orm';
import type { Session } from '@cindy/maker-core';
import { resolveProjectDirectories } from '@cindy/maker-shared/project-alias-sync';
import { getDbClient } from './localDb/client/current.js';
import { sessions } from './localDb/schema.js';
import { readProjectDirectories } from './projectDirectoryStore.js';
import { getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from './appSessionState.js';
import {
  libraryRootForRuntime,
  directoryGrantsForRuntime,
  excludeDirectoryGrantConflictsWithSlots,
} from './maker-ipc/extraDirsValidator.js';
import { throwIpcError } from './utils/ipcValidate.js';

type LocalTurnWrites = { activeDirs: string[]; projectDirs: Set<string> };
const inheritedSessions = new WeakMap<Session, LocalTurnWrites | null>();

/** One task edit, including its rollback. Only the turn hook may add to an inherited profile. */
export function createTaskWritableDirsUpdater(session: Session) {
  let turn: LocalTurnWrites | null | undefined;
  let beforeEdit: string[] = [];
  return async (dirs: string[]) => {
    const current = inheritedSessions.get(session);
    if (!current) return session.setWritableDirs(dirs);
    if (turn !== current) {
      turn = current;
      beforeEdit = current.activeDirs;
    }
    const retained = beforeEdit.filter(dir => current.projectDirs.has(dir) || dirs.includes(dir));
    await session.setWritableDirs(retained);
    current.activeDirs = retained;
  };
}

const parseLegacy = (raw: string | null) => {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) &&
      parsed.every((value): value is string => typeof value === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
};

/** Take one project snapshot at the next turn boundary; never mutate task overrides or running turns. */
export async function applyProjectDirectoriesForTurn(session: Session): Promise<void> {
  const owner = getActiveDataOwnerPushStamp();
  const [row] = await getDbClient()
    .drizzle.select({
      projectDir: sessions.projectDir,
      workingDir: sessions.workingDir,
      remoteHostId: sessions.remoteHostId,
      workspaceKind: sessions.workspaceKind,
      source: sessions.source,
      extraDirs: sessions.extraDirs,
      writableDirs: sessions.writableDirs,
    })
    .from(sessions)
    .where(eq(sessions.id, session.id))
    .limit(1);
  if (!row || row.source === 'review') return;
  if (row.workspaceKind !== 'project' && !inheritedSessions.has(session)) return;
  const directory = sessionTaskProjectDirectory(row);
  if (!directory && !inheritedSessions.has(session)) return;
  const key = row.remoteHostId
    ? `remote:${encodeURIComponent(row.remoteHostId)}:${directory}`
    : `local:${directory}`;
  const defaults = directory
    ? resolveProjectDirectories(
        { aliases: [], platform: process.platform, directories: readProjectDirectories() },
        key,
      )
    : undefined;
  if (!defaults && !inheritedSessions.has(session)) return;
  // Never pass a stored path that now resolves elsewhere to an agent. A failed check stops this turn.
  const projectDefaults = await validateProjectDirectories(key, row.workspaceKind === 'project' ? (defaults ?? []) : []);
  const legacyRead = parseLegacy(row.extraDirs);
  const legacyWrite = parseLegacy(row.writableDirs);
  const read = [
    ...new Set([
      ...legacyRead,
      ...projectDefaults.filter((item) => item.access === 'read').map((item) => item.path),
    ]),
  ];
  const projectWrites = new Set(projectDefaults.filter(item => item.access === 'write').map(item => item.path));
  // A pre-existing read-only task override is never silently promoted by project inheritance.
  const write = row.remoteHostId
    ? [...new Set([...legacyWrite, ...projectWrites])].filter(
        (item) =>
          !read.some((blocked) => {
            const within = (parent: string, child: string) => {
              const relative = path.posix.relative(parent, child);
              return (
                !relative ||
                (relative !== '..' &&
                  !relative.startsWith('../') &&
                  !path.posix.isAbsolute(relative))
              );
            };
            return within(item, blocked) || within(blocked, item);
          }),
      )
    : await excludeDirectoryGrantConflictsWithSlots([...new Set(legacyWrite)], read, [...projectWrites]);
  const assertCurrent = () => {
    const current = getActiveDataOwnerPushStamp();
    if (
      isAppSessionBoundaryPending() ||
      current.dataOwnerId !== owner.dataOwnerId ||
      current.ownerGeneration !== owner.ownerGeneration
    )
      throwIpcError('PRECONDITION_FAILED', 'Project account changed');
  };
  assertCurrent();
  const runtime = directoryGrantsForRuntime(read);
  // Install the new write scope first: removed writable roots cannot survive a write → read change.
  if (write.length || session.capabilities.writableDirs?.supported)
    await session.setWritableDirs(write, row.remoteHostId ? {
      hostId: row.remoteHostId,
      directories: write.filter(dir => projectDefaults.some(item => item.access === 'write' && item.path === dir)),
    } : undefined);
  assertCurrent();
  if (runtime.extraDirs.length || session.capabilities.extraDirs.supported)
    await session.setExtraDirs(runtime.extraDirs, libraryRootForRuntime(read), row.remoteHostId ? {
      hostId: row.remoteHostId,
      directories: read.filter(dir => projectDefaults.some(item => item.access === 'read' && item.path === dir)),
    } : undefined);
  assertCurrent();
  inheritedSessions.set(session, !row.remoteHostId && projectDefaults.length > 0 ? {
    activeDirs: write,
    projectDirs: projectWrites,
  } : null);
}
