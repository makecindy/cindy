/**
 * Desktop reads behind `[你开出的任务]` (startedTaskStateNote.ts). Every read is bounded: the opener's
 * rows use `idx_messages_session_created` within the window and a row limit; the tasks are one
 * primary-key query for at most STARTED_TASK_LOOKUP_LIMIT ids, and their state comes from the batch
 * canonical activity reader (one pass over the live list; a task that is not live adds only its
 * latest-terminal read), the projection the task list and get_task_digest are built on.
 */
import { and, desc, eq, gte, inArray, isNull, like, or } from 'drizzle-orm';

import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import type { PersistedSessionActivityFacts } from './sessionActivityProjection.js';
import {
  readStartedTaskStateNote,
  type StartedTaskLive,
  type StartedTaskStateNoteDeps,
} from './startedTaskStateNote.js';

export function createDesktopStartedTaskStateNoteReader(
  createActivityReader: (persisted: ReadonlyMap<string, PersistedSessionActivityFacts>) => (sessionId: string) => Promise<StartedTaskLive>,
): (sessionId: string, opts: { currentSenderSessionId?: string }) => Promise<string | null> {
  const deps: StartedTaskStateNoteDeps = {
    now: () => Date.now(),
    readClearedAt: async (sessionId) => {
      const db = getCurrentDbClientSnapshot()?.client.drizzle;
      if (!db) return null;
      const [row] = await db.select({ clearedAt: sessions.clearedAt }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      return row?.clearedAt ?? null;
    },
    readOpenerRows: async (sessionId, sinceMs, limit) => {
      const db = getCurrentDbClientSnapshot()?.client.drizzle;
      if (!db) return [];
      return db
        .select({
          role: messages.role,
          content: messages.content,
          toolUseId: messages.toolUseId,
          agentMeta: messages.agentMeta,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(and(
          eq(messages.sessionId, sessionId),
          gte(messages.createdAt, sinceMs),
          isNull(messages.rewindAt),
          or(
            and(eq(messages.role, 'tool_use'), like(messages.content, '%send_to_session%')),
            and(eq(messages.role, 'tool_result'), like(messages.content, '%"wake_kind":"created"%')),
            and(eq(messages.role, 'user'), like(messages.agentMeta, '%"senderSessionId"%')),
          ),
        ))
        .orderBy(desc(messages.createdAt))
        .limit(limit);
    },
    readTasks: async (sessionIds) => {
      const db = getCurrentDbClientSnapshot()?.client.drizzle;
      if (!db || sessionIds.length === 0) return [];
      const rows = await db
        .select({
          id: sessions.id,
          title: sessions.title,
          status: sessions.status,
          startedAt: sessions.activeTurnStartedAt,
          endedAt: sessions.lastTurnEndedAt,
          clearedAt: sessions.clearedAt,
        })
        .from(sessions)
        .where(and(inArray(sessions.id, [...sessionIds]), isNull(sessions.remoteHostId)));
      const active = rows.filter((row) => row.status === 'active');
      const readActivity = createActivityReader(new Map(active.map((row) => [row.id, row])));
      const live = new Map<string, StartedTaskLive | null>();
      for (const row of active) live.set(row.id, await readActivity(row.id).catch(() => null));
      return rows.map((row) => ({ id: row.id, title: row.title, status: row.status, live: live.get(row.id) ?? null }));
    },
  };
  return (sessionId, opts) => readStartedTaskStateNote(sessionId, opts, deps);
}
