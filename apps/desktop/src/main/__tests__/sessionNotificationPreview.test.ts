import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { sessions, botProfiles, messages, botSessionLinks } from '../localDb/schema';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { DbClient } from '../localDb/client/DbClient';
import { setCurrentDbClient, clearCurrentDbClient } from '../localDb/client/current';
import { readSessionNotificationPreview } from '../localDb/sessionNotificationPreview';

let sqlite: Database.Database;
let client: DbClient;
beforeEach(() => {
  sqlite = new Database(':memory:');
  for (const table of [sessions, botProfiles, messages, botSessionLinks]) {
    const { name, columns } = getTableConfig(table);
    sqlite.exec(`CREATE TABLE "${name}" (${columns.map((column) => `"${column.name}" ${column.getSQLType()}`).join(', ')})`);
  }
  const db = drizzle(sqlite);
  db.insert(sessions).values({ id: 'main', createdAt: 0, updatedAt: 0, source: 'bot', activeTurnStartedAt: 100, lastTurnEndedAt: 200 }).run();
  db.insert(botProfiles).values({ id: 'bot-1', createdAt: 0, updatedAt: 0, displayName: 'Cindy' }).run();
  db.insert(botSessionLinks).values({ id: 'link-1', createdAt: 0, sessionId: 'main', botId: 'bot-1', role: 'canonical' }).run();
  client = { drizzle: db } as unknown as DbClient;
  setCurrentDbClient(client, 'test-user');
});
afterEach(() => { clearCurrentDbClient(client); sqlite.close(); });
function add(id: string, role: string, content: string, createdAt: number, meta = {}) {
  sqlite.prepare('INSERT INTO messages (id, client_id, session_id, role, content, created_at, agent_meta) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, id, 'main', role, content, createdAt, JSON.stringify(meta));
}
it('reads canonical teammate identity and this turn final from the durable transcript', async () => {
  add('final-2', 'assistant', '**完成**', 150, { turnCompleted: true, assistantPhase: 'final_answer' });
  expect(await readSessionNotificationPreview('main')).toEqual({ teammateName: 'Cindy', reply: { clientId: 'final-2', text: '**完成**' }, eventId: 'turn:100:200' });
});
it('suppresses an old idle event after a new input started', async () => {
  drizzle(sqlite).update(sessions).set({ activeTurnStartedAt: 300 }).run();
  expect(await readSessionNotificationPreview('main')).toEqual({ teammateName: 'Cindy', suppress: true });
});
it('does not reuse an older final in a tool-only completed turn', async () => {
  add('old', 'assistant', 'Old answer', 10, { turnCompleted: true });
  expect(await readSessionNotificationPreview('main')).toEqual({ teammateName: 'Cindy', eventId: 'turn:100:200' });
});
it('uses insertion order for a tool and final arriving in the same millisecond', async () => {
  add('z-tool', 'tool_result', 'tool output', 150);
  add('a-final', 'assistant', 'Current answer', 150, { turnCompleted: true, assistantPhase: 'final_answer' });
  expect(await readSessionNotificationPreview('main')).toMatchObject({ reply: { clientId: 'a-final', text: 'Current answer' } });
  // A subsequent tool at the same timestamp must still prevent a stale preamble.
  add('0-next-tool', 'tool_use', 'next action', 150);
  expect(await readSessionNotificationPreview('main')).toHaveProperty('reply', undefined);
});
it('keeps completion identity stable before and after the final reply is persisted', async () => {
  const before = await readSessionNotificationPreview('main', false);
  add('final-2', 'assistant', 'Finished', 150, { turnCompleted: true });
  const after = await readSessionNotificationPreview('main');
  expect(before).toEqual({ teammateName: 'Cindy', eventId: 'turn:100:200' });
  expect(after.eventId).toBe(before.eventId);
  expect(after.reply?.text).toBe('Finished');
});

it('does not preview a final reply removed by rewind', async () => {
  add('removed', 'assistant', 'Retracted private answer', 150, { turnCompleted: true });
  sqlite.exec("UPDATE messages SET rewind_at = 201 WHERE client_id = 'removed'");
  expect((await readSessionNotificationPreview('main')).reply).toBeUndefined();
});
