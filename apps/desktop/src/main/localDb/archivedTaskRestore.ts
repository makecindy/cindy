import { and, eq, inArray } from 'drizzle-orm';
import { getDbClient } from './client/current.js';
import type { DbClient } from './client/DbClient.js';
import { sessions, botSessionLinks } from './schema.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { withSessionRouteLock } from './sessionRouteLock.js';

/** The status writer and owner fence the caller restores through (the desktop: localDb/ipc/sessions.ts). */
export interface ArchivedTaskRestorePorts<OwnerScope> {
  patchSessionMetaInDb(
    sessionId: string,
    patch: { status: 'active' },
    options: { routeLockHeld?: boolean; signal?: AbortSignal },
  ): Promise<unknown>;
  captureOwnerScope(): OwnerScope;
  isOwnerScopeCurrent(scope: OwnerScope): boolean;
}

/** Sending continues an ordinary archived task. Serialize with archive/delete and
 * use the normal status writer so native projection and all clients see active. */
export async function restoreArchivedTaskForSend<OwnerScope>(
  sessionId: string,
  options: { routeLockHeld?: boolean; signal?: AbortSignal },
  { patchSessionMetaInDb, captureOwnerScope, isOwnerScopeCurrent }: ArchivedTaskRestorePorts<OwnerScope>,
): Promise<void> {
  const ownerScope = captureOwnerScope();
  const db = getDbClient().drizzle;
  const restore = async () => {
    const [row] = await db.select({
      status: sessions.status, source: sessions.source, orcaRole: sessions.orcaRole,
      orcaRemoteLead: sessions.orcaRemoteLead,
    }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!isOwnerScopeCurrent(ownerScope)) throwIpcError('PRECONDITION_FAILED', 'Task owner changed');
    if (row?.status === 'deleted') throwIpcError('NOT_FOUND', 'Session does not exist');
    if (row?.status !== 'archived') return;
    if ((row.source === 'bot' && !(await isTaskListBotLane(db, sessionId)))
      || row.orcaRole === 'worker' || row.orcaRemoteLead) {
      throwIpcError('PRECONDITION_FAILED', 'Restore the managed task before continuing');
    }
    await patchSessionMetaInDb(sessionId, { status: 'active' }, { ...options, routeLockHeld: true });
  };
  if (options.routeLockHeld) await restore();
  else await withSessionRouteLock(sessionId, restore);
}

/**
 * Routine, channel and group lanes are listed with ordinary tasks (`ordinaryTaskListFilter`)
 * and hold no Profile pointer, so they archive, restore and delete like ordinary tasks.
 * IM/routine triggers resume archived lanes; group triggers create a fresh active lane.
 */
export async function isTaskListBotLane(db: DbClient['drizzle'], sessionId: string): Promise<boolean> {
  const [link] = await db
    .select({ role: botSessionLinks.role })
    .from(botSessionLinks)
    .where(and(
      eq(botSessionLinks.sessionId, sessionId),
      inArray(botSessionLinks.role, ['routine', 'channel', 'group']),
    ))
    .limit(1);
  return !!link;
}
