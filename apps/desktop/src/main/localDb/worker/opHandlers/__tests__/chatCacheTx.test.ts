import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { tx } from '../tx.js';
import type { DbClient } from '../../../client/DbClient.js';
import { createSqliteChatHistoryStore } from '../../../../maker-ipc/chatHistoryStore.js';
import type { ChatHistoryState } from '@cindy/maker-shared/chat-history';

// Unit tier: actual worker transaction and SQLite rollback. A cursor committed before its
// tombstone would permanently resurrect content after restart; old Bot tests never covered it.
let db: Database.Database;
let client: DbClient;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(new URL('../../../../../../drizzle/0133_chat_history_cache.sql', import.meta.url), 'utf8'));
  client = { tx: async (name: string, args: unknown) => tx(db, { name, args }) } as DbClient;
});
afterEach(() => db.close());
const state = (cursor = '10', deleted = false): ChatHistoryState => ({ generation: 'one', cursor, metadataDirty: false,
  snapshot: { room: { id: 'room' }, cursor, messages: [] }, pages: { 'limit=100': ['m'] },
  messages: { m: { id: 'm', seq: '1', revision: deleted ? 2 : 1, deleted } } });
const store = (endpoint = 'https://chat.example', human = 'human', reader = human, current = () => true) =>
  createSqliteChatHistoryStore(client, endpoint, human, reader, current);

it('rolls back cursor, page coverage and tombstone together, then survives a new store instance', async () => {
  const cache = store(); await cache.read('room'); await cache.write('room', state());
  db.exec("CREATE TRIGGER fail_chat_write BEFORE UPDATE ON chat_cache_messages BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
  await expect(cache.write('room', state('11', true))).rejects.toThrow('disk full');
  expect(await store().read('room')).toEqual(state());
  db.exec('DROP TRIGGER fail_chat_write');
  await cache.write('room', state('11', true));
  expect(await store().read('room')).toEqual(state('11', true));
});

it('partitions server, verified owner and acting reader, and refuses late owner writes', async () => {
  const cache = store(); await cache.read('room'); await cache.write('room', state());
  for (const other of [store('https://other.example'), store(undefined, 'other-human'), store(undefined, undefined, 'bot')])
    expect(await other.read('room')).toBeUndefined();
  let current = true; const captured = store(undefined, undefined, undefined, () => current);
  await captured.read('room'); current = false;
  await expect(captured.write('room', state('20'))).rejects.toThrow('OWNER_CHANGED');
  expect(await cache.read('room')).toEqual(state());
});

it('refuses to overwrite another instance’s newer cursor and evicts revoked data', async () => {
  const first = store(), second = store();
  await first.read('room'); await second.read('room');
  await first.write('room', state('20', true));
  // Deletes must honor the same CAS boundary as writes, including version reuse after reset.
  await expect(second.write('room', null)).rejects.toThrow('CHAT_CACHE_CONFLICT');
  await expect(second.write('room', state())).rejects.toThrow('CHAT_CACHE_CONFLICT');
  expect(await second.read('room')).toEqual(state('20', true));
  await second.write('room', null);
  // The numeric version restarts at 1 after reset; the old generation must still lose CAS.
  await second.write('room', { ...state('30', true), generation: 'rebuilt' });
  await expect(first.write('room', null)).rejects.toThrow('CHAT_CACHE_CONFLICT');
  await expect(first.write('room', state('21'))).rejects.toThrow('CHAT_CACHE_CONFLICT');
  expect(await second.read('room')).toMatchObject({ cursor: '30', generation: 'rebuilt' });
  await second.write('room', null);
  expect(await first.read('room')).toBeUndefined();
  expect(db.prepare('SELECT count(*) AS n FROM chat_cache_messages').get()).toEqual({ n: 0 });
});
