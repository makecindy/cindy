/**
 * Host side of the inbox helper tools: the live facts behind list_sessions include_inbox,
 * snooze writes, and the inbox "Done" for tasks on this computer.
 *
 * Every rule mirrors the sidebar (docs/product-rules/task-inbox.md). Nothing here persists
 * another copy of a task's state: it reads the island's live projection, the pending-alert
 * queries, the automation bindings and the unread automation runs the sidebar already uses.
 */
import { resolveSessionRightStatus, type SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import type {
  CompleteSessionItem,
  HistoryTaskInboxSignals,
  SetSessionsSnoozeResult,
  SessionSnoozeChangeItem,
} from '@cindy/mcps';

export interface TaskInboxReadDeps {
  liveActivity(): readonly Pick<SessionActivitySnapshot, 'sessionId' | 'phase' | 'attention'>[];
  /** Error tails and interrupted turns the sidebar shows as needing the user. */
  pendingAlertSessionIds(): Promise<ReadonlySet<string>>;
  /** Tasks bound to an enabled automation; null when the scheduler is not ready. */
  followingSessionIds(): Promise<ReadonlySet<string> | null>;
  unreadRunSessionIds(sessionIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export async function readTaskInboxSignals(
  sessionIds: readonly string[],
  deps: TaskInboxReadDeps,
): Promise<Record<string, HistoryTaskInboxSignals>> {
  if (sessionIds.length === 0) return {};
  const live = new Map(deps.liveActivity().map((activity) => [activity.sessionId, activity]));
  const [pending, following, unreadRuns] = await Promise.all([
    deps.pendingAlertSessionIds(),
    deps.followingSessionIds(),
    deps.unreadRunSessionIds(sessionIds),
  ]);
  const signals: Record<string, HistoryTaskInboxSignals> = {};
  for (const id of sessionIds) {
    const activity = live.get(id);
    const right = activity ? resolveSessionRightStatus(activity) : null;
    const running = right === 'running';
    signals[id] = {
      waiting: right === 'awaiting' || right === 'error' || (!running && pending.has(id)),
      running,
      unread: right === 'done' || unreadRuns.has(id),
      following: following?.has(id) === true,
    };
  }
  return signals;
}

export interface TaskInboxCompleteDeps {
  readSession(sessionId: string): Promise<{ status: string; title: string | null } | null>;
  /** Running, queued or not yet sent; true while the runtime is not ready. */
  isBusy(sessionId: string): boolean;
  isImAttached(sessionId: string): boolean;
  /** Tasks bound to an enabled automation; null when the scheduler is not ready. */
  followingSessionIds(): Promise<ReadonlySet<string> | null>;
  /** Clear the unread dot, dismiss pending alerts and mark unread automation runs read. */
  markRead(sessionId: string): Promise<void>;
  /**
   * Archive under the task's route lock, calling recheck right before the write. Uncommitted
   * changes are kept as a recoverable snapshot, as with the sidebar's default and archive_sessions.
   */
  archive(sessionId: string, recheck: () => void): Promise<void>;
}

class CompleteBlocked extends Error {
  constructor(readonly reason: NonNullable<CompleteSessionItem['reason']>) {
    super(reason);
  }
}

/** The inbox "Done" for one task at a time; each item is decided and applied on its own. */
export async function completeLocalSessions(
  sessionIds: readonly string[],
  deps: TaskInboxCompleteDeps,
): Promise<CompleteSessionItem[]> {
  const items: CompleteSessionItem[] = [];
  let following: ReadonlySet<string> | null | undefined;
  for (const sessionId of sessionIds) {
    let title: string | null = null;
    try {
      const row = await deps.readSession(sessionId);
      if (!row) throw new CompleteBlocked('NOT_FOUND');
      title = row.title;
      if (row.status === 'deleted') throw new CompleteBlocked('DELETED');
      if (row.status === 'archived') {
        items.push({ sessionId, title, outcome: 'already_archived' });
        continue;
      }
      const assertIdle = () => {
        if (deps.isBusy(sessionId)) throw new CompleteBlocked('RUNNING');
        if (deps.isImAttached(sessionId)) throw new CompleteBlocked('IM_ATTACHED');
      };
      assertIdle();
      // Unknown bindings count as none, as in the sidebar (task-inbox.md).
      following ??= await deps.followingSessionIds();
      if (following?.has(sessionId)) {
        await deps.markRead(sessionId);
        items.push({ sessionId, title, outcome: 'marked_read' });
        continue;
      }
      await deps.archive(sessionId, assertIdle);
      items.push({ sessionId, title, outcome: 'archived' });
    } catch (error) {
      const reason = error instanceof CompleteBlocked ? error.reason : blockedReasonOf(error);
      items.push({ sessionId, title, outcome: 'blocked', reason });
    }
  }
  return items;
}

function blockedReasonOf(error: unknown): NonNullable<CompleteSessionItem['reason']> {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'NOT_FOUND') return 'NOT_FOUND';
  if (code === 'PRECONDITION_FAILED') return 'PRECONDITION_FAILED';
  return 'FAILED';
}

/** Local snooze writes: same sequential, stop-on-first-failure contract as the remote path. */
export async function setLocalSessionsSnooze(
  params: { sessionIds: string[]; snoozedUntil: string | null },
  write: (sessionId: string, snoozedUntil: string | null) => Promise<Record<string, unknown>>,
): Promise<SetSessionsSnoozeResult> {
  const changed: SessionSnoozeChangeItem[] = [];
  for (const [index, sessionId] of params.sessionIds.entries()) {
    try {
      changed.push(snoozeChangeItem(sessionId, await write(sessionId, params.snoozedUntil)));
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return {
        ok: false,
        errorCode: code === 'NOT_FOUND' || code === 'INVALID_PARAMS' || code === 'PRECONDITION_FAILED'
          ? (code === 'INVALID_PARAMS' ? 'INVALID_ARGS' : code)
          : 'INTERNAL',
        message: error instanceof Error ? error.message : String(error),
        changed,
        failedSessionId: sessionId,
        remainingSessionIds: params.sessionIds.slice(index + 1),
      };
    }
  }
  return { ok: true, changed };
}

export function snoozeChangeItem(sessionId: string, row: Record<string, unknown>): SessionSnoozeChangeItem {
  return {
    sessionId,
    title: typeof row.title === 'string' ? row.title : null,
    snoozedUntil: typeof row.snoozedUntil === 'string' ? row.snoozedUntil : null,
    snoozedAt: typeof row.snoozedAt === 'string' ? row.snoozedAt : null,
  };
}
