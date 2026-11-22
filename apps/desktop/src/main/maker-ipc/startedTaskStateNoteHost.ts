/**
 * Desktop reads behind `[你开出的任务]` (startedTaskStateNote.ts). Every read is bounded: the opener's
 * rows use `idx_messages_session_created` within the window and a row limit, the task rows are a
 * primary-key lookup of at most 20 ids, and the live phase is the
 * in-memory runtime snapshot get_task_digest already reads.
 */
import { and, desc, eq, gte, inArray, isNull, like, or } from 'drizzle-orm';

import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import {
  readStartedTaskStateNote,
  type StartedTaskLive,
  type StartedTaskStateNoteDeps,
} from './startedTaskStateNote.js';

export function createDesktopStartedTaskStateNoteReader(
  readLive: (sessionId: string) => Promise<StartedTaskLive | null>,
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
      return db
        .select({ id: sessions.id, title: sessions.title, status: sessions.status })
        .from(sessions)
        .where(and(inArray(sessions.id, [...sessionIds]), isNull(sessions.remoteHostId)));
    },
    readPhase: readLive,
  };
  return (sessionId, opts) => readStartedTaskStateNote(sessionId, opts, deps);
}
