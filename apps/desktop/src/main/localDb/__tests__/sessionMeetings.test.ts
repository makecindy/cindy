import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionMeetingJournal } from '../sessionMeetings.js';
import type { SessionMeetingSnapshot } from '@cindy/device-link';

const snapshot = (revision = 1): SessionMeetingSnapshot => ({
  meetingId: 'meeting', sessionId: 'session', ownerAccountId: 'owner', hostDeviceId: 'desktop',
  revision, status: 'active', guests: [{ memberId: 'member', accountId: 'guest', version: 1, deviceIds: ['phone'] }],
});
let db: Database.Database;
let journal: ReturnType<typeof createSessionMeetingJournal>;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('session'), ('other-session')");
  db.exec(readFileSync(resolve(process.cwd(), 'drizzle/0108_session_meeting_events.sql'), 'utf8'));
  journal = createSessionMeetingJournal({
    async exec(sql, params = []) { return db.prepare(sql).run(...params); },
    async query<T>(sql: string, params: unknown[] = []) { return db.prepare(sql).all(...params) as T[]; },
  });
});
afterEach(() => db.close());
describe('meeting authority journal', () => {
  it('retains membership changes and reads only the latest authority', async () => {
    expect(await journal.recordAuthority(snapshot())).toBe(true);
    expect(await journal.recordAuthority({ ...snapshot(2), guests: [] })).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_meeting_events').get()).toEqual({ n: 2 });
    expect(await journal.latest()).toMatchObject([{ snapshot: { revision: 2, guests: [] }, terminal: false }]);
  });
  it('ignores stale and duplicate revisions without losing audit history', async () => {
    await journal.recordAuthority(snapshot(2));
    expect(await journal.recordAuthority(snapshot())).toBe(false);
    expect(await journal.recordAuthority(snapshot(2))).toBe(false);
    expect(await journal.latest()).toMatchObject([{ snapshot: { revision: 2 } }]);
  });
  it('does not let another task reuse a meeting identity', async () => {
    await journal.recordAuthority(snapshot());
    expect(await journal.recordAuthority({ ...snapshot(2), sessionId: 'other-session' })).toBe(false);
    await journal.close({ ...snapshot(), sessionId: 'other-session' });
    expect(await journal.latest()).toMatchObject([{ sessionId: 'session', terminal: false }]);
  });
  it.each(['local', 'server'])('keeps a %s closure terminal when late replies arrive', async (source) => {
    await journal.recordAuthority(snapshot());
    if (source === 'local') { await journal.close(snapshot()); await journal.close(snapshot()); }
    else await journal.recordAuthority({ ...snapshot(2), status: 'closed' });
    expect(await journal.recordAuthority(snapshot(20))).toBe(false);
    expect(await journal.latest()).toMatchObject([{ terminal: true }]);
  });
  it('allows a fresh meeting for the same task after closing the previous one', async () => {
    await journal.close(snapshot());
    expect(await journal.recordAuthority({ ...snapshot(), meetingId: 'new-meeting' })).toBe(true);
    expect(await journal.latest()).toHaveLength(2);
  });
  it('cascades journal deletion only with its owning task', async () => {
    await journal.recordAuthority(snapshot());
    db.prepare("DELETE FROM sessions WHERE id = 'other-session'").run();
    expect(await journal.latest()).toHaveLength(1);
    db.prepare("DELETE FROM sessions WHERE id = 'session'").run();
    expect(await journal.latest()).toEqual([]);
  });
});
