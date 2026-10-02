import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { createTaskToolCallAuthorizer } from '../taskToolCallAuthorizer.js';

describe('shared task tool admission', () => {
  let sqlite: Database.Database;
  let db: Pick<DbClient, 'drizzle'>;
  let current: boolean;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, source TEXT); INSERT INTO sessions VALUES ('companion','active','bot'),('ordinary','active','desktop'),('automation','active','scheduler'),('hook','active','hook');");
    db = { drizzle: drizzle(sqlite) } as unknown as Pick<DbClient, 'drizzle'>;
    current = true;
  });
  afterEach(() => sqlite.close());
  const commands = [
    ['cindy_helper', 'archive_sessions'], ['cindy_helper', 'some_future_tool'],
    ['cindy_helper', 'set_teammate_capability'], ['cindy_scheduler', 'schedule_create'],
  ] as const;
  it('uses the same admission for ordinary tasks and companions, including future tools', async () => {
    const authorize = createTaskToolCallAuthorizer({ getDb: () => db, isScopeCurrent: () => current });
    for (const sessionId of ['ordinary', 'companion']) for (const [server, tool] of commands)
      expect(await authorize({ sessionId, server, tool, args: {} })).toEqual({ ok: true });
  });
  it.each(['companion', 'ordinary', 'automation', 'hook'])('allows the next tool call after archiving %s, but rejects deletion', async (sessionId) => {
    const authorize = createTaskToolCallAuthorizer({ getDb: () => db, isScopeCurrent: () => current });
    for (const status of ['active', 'archived', 'deleted']) {
      sqlite.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, sessionId);
      for (const [server, tool] of commands) {
        expect(await authorize({ sessionId, server, tool, args: {} })).toMatchObject(status === 'deleted'
          ? { ok: false, errorCode: 'TASK_UNAVAILABLE' } : { ok: true });
      }
    }
  });
  it('retains missing caller and account-change checks', async () => {
    const authorize = createTaskToolCallAuthorizer({ getDb: () => db, isScopeCurrent: () => current });
    for (const sessionId of [undefined, 'missing'])
      expect((await authorize({ sessionId, server: 'cindy_helper', tool: 'list_sessions', args: {} })).ok).toBe(false);
    current = false;
    expect(await authorize({ sessionId: 'companion', server: 'cindy_helper', tool: 'list_sessions', args: {} }))
      .toMatchObject({ ok: false, errorCode: 'OWNER_SCOPE_CHANGED' });
    expect(await createTaskToolCallAuthorizer({ getDb: () => null, isScopeCurrent: () => true })({
      sessionId: 'companion', server: 'cindy_helper', tool: 'list_sessions', args: {},
    })).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
  });
});
