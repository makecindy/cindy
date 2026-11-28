import { eq, sql } from 'drizzle-orm';
import { isTeammateOwnInboxTask, type TaskInboxState } from '@cindy/maker-shared/live-task-priority';
import { sessions } from './schema.js';
import { getDbClient } from './client/current.js';

/** The row facts the shared inbox rules read, so the phone count lists the same tasks. */
export interface SessionInboxFacts extends TaskInboxState {
  kind: 'canonical' | 'teammate-task' | 'task';
}

const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());

export async function readSessionInboxFacts(sessionId: string): Promise<SessionInboxFacts | null> {
  const [row] = await getDbClient()
    .drizzle.select({
      status: sessions.status,
      pinnedAt: sessions.pinnedAt,
      snoozedUntil: sessions.snoozedUntil,
      snoozedAt: sessions.snoozedAt,
      userSendAt: sessions.userSendAt,
      lastTurnEndedAt: sessions.lastTurnEndedAt,
      source: sessions.source,
      projectDir: sessions.projectDir,
      workingDir: sessions.workingDir,
      // The same persisted link the task list reads as `session.companion.role`.
      companionRole: sql<string | null>`(SELECT l.role FROM bot_session_links l WHERE l.session_id = ${sessions.id} LIMIT 1)`,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return null;
  // A teammate's main conversation also wakes on a new reply (see `botInboxSnooze` in
  // ipc/bots.ts); a reply ends a turn, so the turn end stands in for the reply time.
  const canonical = row.companionRole === 'canonical';
  const inputAt = canonical
    ? Math.max(row.userSendAt ?? 0, row.lastTurnEndedAt ?? 0) || null
    : row.userSendAt;
  return {
    status: row.status,
    pinnedAt: iso(row.pinnedAt),
    snoozedUntil: iso(row.snoozedUntil),
    snoozedAt: iso(row.snoozedAt),
    userSendAt: iso(inputAt),
    // Main conversations live under the teammate workspace too, but have their own inbox row.
    kind: canonical ? 'canonical' : isTeammateOwnInboxTask({
      source: row.source,
      companion: row.companionRole ? { role: row.companionRole } : null,
      projectDir: row.projectDir,
      workingDir: row.workingDir,
    }) ? 'teammate-task' : 'task',
  };
}
