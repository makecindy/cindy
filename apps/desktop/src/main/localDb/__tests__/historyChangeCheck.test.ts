import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current';
import type { DbClient } from '../client/DbClient';
import { hasConversationChanges } from '../historyChangeCheck';

// DB tier: exercise the production existence query against real SQLite. A scheduled
// turn is the minimal self-wake regression; a human reply in that session must still wake.
let db: Database.Database;
afterEach(() => {
  clearCurrentDbClient();
  db?.close();
});
it('ignores scheduled turns while retaining human replies, malformed origins and time boundaries', async () => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, created_at INTEGER, rewind_at INTEGER, agent_meta TEXT);
    CREATE INDEX message_time ON messages(created_at);
    CREATE INDEX session_time ON messages(session_id, created_at);
    INSERT INTO sessions VALUES ('s', 'active');`);
  setCurrentDbClient(
    {
      queryOne: async (sql: string, params: unknown[]) => db.prepare(sql).get(...params),
    } as DbClient,
    'test-owner',
  );
  const add = (id: string, role: string, at: number, meta: string | null = null) =>
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, NULL, ?)').run(id, 's', role, at, meta);
  expect(await hasConversationChanges(0, 100)).toBe(false);
  add(
    'automatic',
    'user',
    10,
    JSON.stringify({ origin: { kind: 'scheduler', scheduleId: 'test' } }),
  );
  add('automatic-answer', 'assistant', 11);
  expect(await hasConversationChanges(0, 100)).toBe(false);
  add('human', 'user', 20);
  add('human-answer', 'assistant', 21);
  expect(await hasConversationChanges(20, 21)).toBe(true);
  expect(await hasConversationChanges(21, 22)).toBe(true);
  expect(await hasConversationChanges(22, 100)).toBe(false);
  add('malformed', 'user', 30, '{');
  expect(await hasConversationChanges(30, 31)).toBe(true);
  db.exec("UPDATE messages SET rewind_at = 40 WHERE id = 'malformed'");
  expect(await hasConversationChanges(30, 31)).toBe(false);
  db.exec("UPDATE sessions SET status = 'deleted'");
  expect(await hasConversationChanges(20, 22)).toBe(false);
});
