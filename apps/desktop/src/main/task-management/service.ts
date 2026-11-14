import { and, eq, inArray } from 'drizzle-orm';
import { activeDataOwnerId } from '../ownerContext.js';
import { getDbClient, getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { withSessionRouteLock } from '../localDb/sessionRouteLock.js';
import { setSessionRestoreObserver } from '../localDb/sessionRestoreRetention.js';
import { patchSessionMetaInDb } from '../localDb/ipc/sessions.js';
import { isProvisionalSession } from '../localDb/provisionalSessions.js';
import { createLogger } from '../logger.js';
import { createTaskArchiveEngine } from './engine.js';
import { createTaskArchiveScheduler } from './scheduler.js';
import {
  ARCHIVE_CANDIDATE_SELECT,
  type ArchiveCandidateRow,
  type ArchiveProtection,
} from './eligibility.js';
import { taskManagementScope, taskManagementStore } from './store.js';
import type { TaskArchiveNotice, TaskArchiveSettings } from '../../shared/taskManagement.js';

const log = createLogger('task-management');
let runtime: {
  busy(id: string): boolean;
  waiting(id: string): boolean;
  pending(id: string): Promise<boolean>;
} | null = null;
let platform: {
  canRun(): boolean;
  protection(): ArchiveProtection;
  notice(value: TaskArchiveNotice): void;
  settingsChanged(): void;
} | null = null;
const unavailable: ArchiveProtection = {
  ready: false,
  viewed: new Set(),
  drafts: new Set(),
  remoteUnknown: false,
};
export const taskArchiveEngine = createTaskArchiveEngine({
  scope: () => {
    const scope = taskManagementScope();
    const db = getCurrentDbClientSnapshot();
    if (!db || db.userId !== activeDataOwnerId())
      throw new Error('TASK_ARCHIVE_DATABASE_NOT_READY');
    return `${scope}:${db.clientEpoch}`;
  },
  ownerId: () => activeDataOwnerId()!,
  settings: taskManagementStore.read,
  restoredAt: taskManagementStore.restoredAt,
  canRun: () => platform?.canRun() ?? false,
  countActive: async () => {
    const row = await getDbClient().queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'",
    );
    return row?.count ?? 0;
  },
  list: (afterId) =>
    getDbClient().query<ArchiveCandidateRow>(
      `${ARCHIVE_CANDIDATE_SELECT}
    WHERE s.status = 'active' AND s.id > ? ORDER BY s.id LIMIT 128`,
      [afterId],
    ),
  read: (id) =>
    getDbClient().queryOne<ArchiveCandidateRow>(`${ARCHIVE_CANDIDATE_SELECT} WHERE s.id = ?`, [id]),
  protection: () => (runtime && platform ? platform.protection() : unavailable),
  busy: (id) => isProvisionalSession(id) || !runtime || runtime.busy(id),
  waiting: (id) => runtime?.waiting(id) ?? false,
  pending: (id) => (runtime ? runtime.pending(id) : Promise.resolve(true)),
  withLock: withSessionRouteLock,
  archive: async (id, cutoff, beforeWrite) => {
    const row = await patchSessionMetaInDb(
      id,
      { status: 'archived' },
      { routeLockHeld: true, beforeWrite, idleArchiveCutoff: cutoff },
    );
    return Date.parse(row.updatedAt);
  },
  restore: async (id, beforeWrite) => {
    await patchSessionMetaInDb(id, { status: 'active' }, { routeLockHeld: true, beforeWrite });
  },
  notice: (value) => platform?.notice(value),
  now: Date.now,
  warn: () => log.warn('Idle task archive check skipped or interrupted'),
});
const scheduler = createTaskArchiveScheduler({
  check: taskArchiveEngine.check,
  settled: taskArchiveEngine.settled,
  invalidate: taskArchiveEngine.invalidate,
  warn: () => log.warn('Idle task archive scheduling interrupted'),
});

/** MainLayout reports only after mounting; runtime + every window must be ready. */
export function refreshTaskArchiveReadiness(): void {
  let ready = false;
  try {
    ready = Boolean(runtime && platform?.canRun() && platform.protection().ready);
  } catch {
    // Account/database boundaries are not ready for background maintenance.
  }
  scheduler.setReady(ready);
}
export function requestTaskArchiveCheck(force = true): void {
  refreshTaskArchiveReadiness();
  scheduler.request(force);
}

/** Metadata is persisted before restoring, including manual/remote/Agent restores. */
setSessionRestoreObserver(async (ids, db) => {
  const scope = taskManagementScope();
  const current = getCurrentDbClientSnapshot();
  if (!current || current.client.drizzle !== db || current.userId !== activeDataOwnerId()) {
    throw new Error('TASK_ARCHIVE_SCOPE_CHANGED');
  }
  for (let offset = 0; offset < ids.length; offset += 128) {
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          inArray(sessions.id, [...ids.slice(offset, offset + 128)]),
          eq(sessions.status, 'archived'),
        ),
      );
    if (scope !== taskManagementScope()) throw new Error('TASK_ARCHIVE_SCOPE_CHANGED');
    await taskManagementStore.restored(
      rows.map((row) => row.id),
      Date.now(),
    );
    if (scope !== taskManagementScope()) throw new Error('TASK_ARCHIVE_SCOPE_CHANGED');
  }
});

/** UI and Agent settings share persistence, notifications and scheduling. */
export async function updateTaskArchiveSettings(patch: Partial<TaskArchiveSettings> | null) {
  const scope = taskManagementScope();
  taskArchiveEngine.invalidate();
  const value =
    patch === null ? await taskManagementStore.reset() : await taskManagementStore.update(patch);
  if (scope !== taskManagementScope()) throw new Error('TASK_ARCHIVE_SCOPE_CHANGED');
  platform?.settingsChanged();
  requestTaskArchiveCheck();
  return value;
}

export function configureTaskArchivePlatform(next: typeof platform): void {
  platform = next;
  refreshTaskArchiveReadiness();
}
export function configureTaskArchiveRuntime(next: typeof runtime): void {
  scheduler.setReady(false);
  runtime = next;
  taskArchiveEngine.invalidate();
  refreshTaskArchiveReadiness();
}
