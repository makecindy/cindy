import { parseSessionMeetingSnapshot, type SessionMeetingIdentity, type SessionMeetingSnapshot } from '@cindy/device-link';
import type { DbClient } from './client/DbClient.js';

export interface SessionMeetingJournalEntry {
  meetingId: string;
  sessionId: string;
  terminal: boolean;
  snapshot: SessionMeetingSnapshot | null;
}

/** Bound to one profile's DbClient; never resolves a different account after an await. */
export function createSessionMeetingJournal(db: Pick<DbClient, 'exec' | 'query'>, now: () => number = Date.now) {
  return {
    async recordAuthority(value: SessionMeetingSnapshot): Promise<boolean> {
      const snapshot = parseSessionMeetingSnapshot(value);
      // A single atomic statement records both the recovery snapshot and its
      // membership audit entry. A terminal record permanently fences late replies.
      const result = await db.exec(`
        INSERT INTO session_meeting_events (meeting_id, session_id, revision, kind, terminal, snapshot, recorded_at)
        SELECT ?, ?, ?, 'authority', ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM session_meeting_events
          WHERE meeting_id = ? AND (terminal = 1 OR session_id <> ? OR revision >= ?)
        )
        ON CONFLICT (meeting_id, kind, revision) DO NOTHING
      `, [snapshot.meetingId, snapshot.sessionId, snapshot.revision, snapshot.status === 'closed' ? 1 : 0,
        JSON.stringify(snapshot), now(), snapshot.meetingId, snapshot.sessionId, snapshot.revision]);
      return result.changes > 0;
    },
    async close(identity: SessionMeetingIdentity): Promise<void> {
      // Revision zero is reserved for a local closure, not a server revision.
      // Never manufacture a higher authority revision from the local clock.
      const checked = parseSessionMeetingSnapshot({ ...identity, revision: 1, status: 'closed', guests: [] });
      await db.exec(`
        INSERT INTO session_meeting_events (meeting_id, session_id, revision, kind, terminal, snapshot, recorded_at)
        SELECT ?, ?, 0, 'local-close', 1, NULL, ?
        WHERE NOT EXISTS (SELECT 1 FROM session_meeting_events WHERE meeting_id = ? AND session_id <> ?)
        ON CONFLICT (meeting_id, kind, revision) DO NOTHING
      `, [checked.meetingId, checked.sessionId, now(), checked.meetingId, checked.sessionId]);
    },
    async latest(): Promise<SessionMeetingJournalEntry[]> {
      const rows = await db.query<{ meeting_id: string; session_id: string; terminal: number; snapshot: string | null }>(`
        SELECT meeting_id, session_id, terminal, snapshot FROM session_meeting_events
        WHERE id IN (SELECT MAX(id) FROM session_meeting_events GROUP BY meeting_id)
      `);
      return rows.map((row) => {
        const snapshot = row.snapshot === null ? null : parseSessionMeetingSnapshot(JSON.parse(row.snapshot));
        if (snapshot && (snapshot.meetingId !== row.meeting_id || snapshot.sessionId !== row.session_id)) throw new Error('Meeting journal scope mismatch');
        return { meetingId: row.meeting_id, sessionId: row.session_id, terminal: row.terminal === 1, snapshot };
      });
    },
  };
}

export type SessionMeetingJournal = ReturnType<typeof createSessionMeetingJournal>;
