import { eq } from 'drizzle-orm';

import { sessions } from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import { removeSessionRefsIfDeleted, type LedgerDb } from './ledger.js';

const log = createLogger('cindy-media-session-cleanup');

export interface ReconcileDeletedSessionMediaOptions {
  db: LedgerDb;
  isOwnerCurrent(): boolean;
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  quiesceSession(sessionId: string): Promise<void>;
  removeRefsIfDeleted?: (sessionId: string, db: LedgerDb) => Promise<number>;
}

export interface ReconcileDeletedSessionMediaResult {
  scanned: number;
  removed: number;
  failed: number;
  ownerChanged: boolean;
}

/**
 * Retry runtime quiescence and session-ref cleanup from durable soft-delete
 * tombstones. Archived Simulator ownership is reconciled in one bounded Host
 * registry pass before this media cleanup runs. The atomic ledger guard still
 * preserves refs unless the task remains deleted when the DELETE executes.
 */
export async function reconcileSessionMediaRefsForDeletedSessions(
  options: ReconcileDeletedSessionMediaOptions,
): Promise<ReconcileDeletedSessionMediaResult> {
  const result: ReconcileDeletedSessionMediaResult = {
    scanned: 0,
    removed: 0,
    failed: 0,
    ownerChanged: false,
  };
  if (!options.isOwnerCurrent()) {
    result.ownerChanged = true;
    return result;
  }

  let rows: Array<{ id: string }>;
  try {
    rows = await options.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.status, 'deleted'))
      .all();
  } catch (error) {
    log.warn('deleted task media reconcile query failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    result.failed = 1;
    return result;
  }

  const removeRefs = options.removeRefsIfDeleted ?? removeSessionRefsIfDeleted;
  for (const row of rows) {
    if (!options.isOwnerCurrent()) {
      result.ownerChanged = true;
      break;
    }
    result.scanned += 1;
    try {
      const removed = await options.withSessionLock(row.id, async () => {
        if (!options.isOwnerCurrent()) return null;
        const [current] = await options.db
          .select({ status: sessions.status })
          .from(sessions)
          .where(eq(sessions.id, row.id))
          .limit(1)
          .all();
        if (!options.isOwnerCurrent() || current?.status !== 'deleted') return null;
        await options.quiesceSession(row.id);
        if (!options.isOwnerCurrent()) return null;
        return removeRefs(row.id, options.db);
      });
      if (!options.isOwnerCurrent()) {
        result.ownerChanged = true;
        break;
      }
      result.removed += removed ?? 0;
    } catch (error) {
      result.failed += 1;
      log.warn('deleted task media reconcile item failed', {
        sessionId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
