/**
 * PR reference hooks of the message write paths, shared by the desktop (localDb/ipc/messages.ts) and the
 * Node Host (apps/host message store and event persistence). Moved verbatim from localDb/ipc/messages.ts:
 * a created message records its PR references fire-and-forget, and a correction or retraction of a row first
 * settles that row's record before recomputing the task's references from live history.
 */
import { recomputePrRefsForSession, recordPrRefsForMessage } from '../git-context/prRefsStore';
import type { DbClient } from './client/DbClient';
import { createLogger } from '../logger';

// Same scope as localDb/ipc/messages.ts, where these lines were written: the log lines stay as they were.
const log = createLogger('localDb/messages');

// Normal publication stays non-blocking. Authoritative corrections/retractions
// settle the exact row's create/update hooks before reconciling derived state.
const pendingPrRefWrites = new WeakMap<DbClient, Map<string, Promise<void>>>();

/** The fields of a created message that recordPrRefsForMessage reads. */
export interface PrRefsMessage {
  id: string;
  sessionId: string;
  role: string;
  content: unknown;
  createdAt: string | number;
}

/** A corrected or retracted message row. */
export interface PrRefsMessageRow {
  id: string;
  sessionId: string;
  clientId: string;
}

/** Record a created message's PR references without waiting, and remember the write for later corrections. */
export function trackMessagePrRefs(dbClient: DbClient, msg: PrRefsMessage): void {
  const prRefsWrite = recordPrRefsForMessage(msg).catch(() => {
    // recordPrRefsForMessage 内部已 try/catch,此处兜底防御 refactor 漏网异常。
  });
  let pendingPrRefs = pendingPrRefWrites.get(dbClient);
  if (!pendingPrRefs) {
    pendingPrRefs = new Map();
    pendingPrRefWrites.set(dbClient, pendingPrRefs);
  }
  pendingPrRefs.set(msg.id, prRefsWrite);
  void prRefsWrite.then(() => {
    if (pendingPrRefs.get(msg.id) === prRefsWrite) pendingPrRefs.delete(msg.id);
  });
}

/** After a correction or retraction of an assistant row: settle its record, then recompute. */
export async function reconcileCorrectedMessagePrRefs(
  row: PrRefsMessageRow,
  dbClient: DbClient,
  isCurrent: () => boolean,
): Promise<void> {
  await pendingPrRefWrites.get(dbClient)?.get(row.id);
  try {
    if (isCurrent()) await recomputePrRefsForSession(row.sessionId, { dbClient, isCurrent });
  } catch (error) {
    log.warn('assistant correction PR reference reconciliation failed', {
      sessionId: row.sessionId, clientId: row.clientId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** After a content update of a user or assistant row with no original to correct: settle, then recompute. */
export async function reconcileUpdatedMessagePrRefs(
  dbClient: DbClient,
  sessionId: string,
  rowId: string,
  isCurrent: () => boolean,
): Promise<void> {
  await pendingPrRefWrites.get(dbClient)?.get(rowId);
  if (isCurrent()) await recomputePrRefsForSession(sessionId, { dbClient, isCurrent });
}
