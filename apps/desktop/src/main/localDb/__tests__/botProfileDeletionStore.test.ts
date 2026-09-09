import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  tx: null as null | ((name: string, args: unknown) => Promise<unknown>),
}));

vi.mock('../client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db, tx: h.tx }),
}));

import { commitBotProfileDeletion } from '../botProfileDeletionStore.js';
import { tx as runWorkerTx } from '../worker/opHandlers/tx.js';

describe('Bot profile deletion transaction', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE bot_session_links (
        bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        content TEXT NOT NULL
      );
      CREATE TABLE bot_delegations (
        id TEXT PRIMARY KEY,
        requesting_bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        target_bot_id TEXT REFERENCES bot_profiles(id) ON DELETE CASCADE
      );
      CREATE TABLE bot_direct_message_threads (
        id TEXT PRIMARY KEY,
        bot_a_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        bot_b_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE
      );
      CREATE TABLE bot_direct_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES bot_direct_message_threads(id) ON DELETE CASCADE,
        sender_bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        recipient_bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        content TEXT NOT NULL
      );
      CREATE TABLE media_refs (id TEXT PRIMARY KEY, ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL);
      INSERT INTO bot_profiles VALUES ('bot-1', 'archived'), ('bot-2', 'active'), ('bot-3', 'active');
      INSERT INTO sessions VALUES
        ('canonical', 'bot', 'archived', 1),
        ('route', 'bot', 'archived', 1),
        ('ordinary', 'desktop', 'active', 1);
      INSERT INTO messages VALUES ('message-1', 'canonical', 'Retained transcript');
      INSERT INTO bot_session_links VALUES
        ('bot-1', 'canonical'),
        ('bot-1', 'route');
      INSERT INTO media_refs VALUES
        ('avatar-ref', 'bot-avatar', 'bot-1'),
        ('other-ref', 'bot-avatar', 'bot-2');
    `);
    const db = drizzle(sqlite);
    h.db = db;
    h.tx = async (name, args) => runWorkerTx(sqlite, { name: name as never, args } as never);
  });

  afterEach(() => sqlite.close());

  function snapshot() {
    return Object.fromEntries([
      'bot_profiles', 'sessions', 'messages', 'bot_session_links', 'media_refs',
      'bot_delegations', 'bot_direct_message_threads', 'bot_direct_messages',
    ].map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  }

  describe.each([true, false])('shared history with keepTaskHistory=%s', (keepTaskHistory) => {
    async function expectDeletionRejected() {
      const before = snapshot();
      await expect(commitBotProfileDeletion({
        botId: 'bot-1', sessionIds: ['canonical', 'route'], keepTaskHistory,
      })).rejects.toMatchObject({ code: 'BOT_SHARED_HISTORY_REFERENCED' });
      expect(snapshot()).toEqual(before);
    }

    it.each(['target', 'requester'])('preserves shared delegation when deleting its %s', async (role) => {
      sqlite.prepare('INSERT INTO bot_delegations VALUES (?, ?, ?)').run(
        'delegation-1', role === 'target' ? 'bot-2' : 'bot-1', role === 'target' ? 'bot-1' : 'bot-2',
      );
      await expectDeletionRejected();
    });

    it.each(['a', 'b'])('preserves a private thread and its messages when deleting member %s', async (member) => {
      sqlite.prepare('INSERT INTO bot_direct_message_threads VALUES (?, ?, ?)').run(
        'thread-1', member === 'a' ? 'bot-1' : 'bot-2', member === 'a' ? 'bot-2' : 'bot-1',
      );
      sqlite.exec(`INSERT INTO bot_direct_messages VALUES
        ('dm-1', 'thread-1', 'bot-1', 'bot-2', 'Request'),
        ('dm-2', 'thread-1', 'bot-2', 'bot-1', 'Reply')`);
      await expectDeletionRejected();
    });

    it('preserves a private thread even before its first message', async () => {
      sqlite.exec("INSERT INTO bot_direct_message_threads VALUES ('thread-1', 'bot-1', 'bot-2')");
      await expectDeletionRejected();
    });

    it.each(['sender', 'recipient'])('checks actual message %s references independently of thread membership', async (role) => {
      sqlite.exec("INSERT INTO bot_direct_message_threads VALUES ('thread-1', 'bot-2', 'bot-3')");
      sqlite.prepare('INSERT INTO bot_direct_messages VALUES (?, ?, ?, ?, ?)').run(
        'dm-1', 'thread-1', role === 'sender' ? 'bot-1' : 'bot-2',
        role === 'sender' ? 'bot-2' : 'bot-1', 'Retained shared message',
      );
      await expectDeletionRejected();
    });
  });

  it('atomically detaches kept transcripts and removes the Profile', async () => {
    await commitBotProfileDeletion({
      botId: 'bot-1',
      sessionIds: ['canonical', 'route', 'canonical'],
      keepTaskHistory: true,
    });

    expect(sqlite.prepare("SELECT id FROM bot_profiles WHERE id = 'bot-1'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT id FROM media_refs WHERE id = 'avatar-ref'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT id FROM media_refs WHERE id = 'other-ref'").get())
      .toEqual({ id: 'other-ref' });
    expect(sqlite.prepare("SELECT source, status FROM sessions WHERE id = 'canonical'").get())
      .toEqual({ source: 'desktop', status: 'archived' });
    expect(sqlite.prepare("SELECT source, status FROM sessions WHERE id = 'route'").get())
      .toEqual({ source: 'desktop', status: 'archived' });
    expect(sqlite.prepare('SELECT * FROM messages').all()).toEqual([
      { id: 'message-1', session_id: 'canonical', content: 'Retained transcript' },
    ]);
  });

  it('allows deletion with only a private background task and unrelated shared history', async () => {
    sqlite.exec(`
      INSERT INTO bot_delegations VALUES ('private-task', 'bot-1', NULL), ('shared-task', 'bot-2', 'bot-3');
      INSERT INTO bot_direct_message_threads VALUES ('thread-2', 'bot-2', 'bot-3');
      INSERT INTO bot_direct_messages VALUES ('dm-2', 'thread-2', 'bot-2', 'bot-3', 'Unrelated history');
    `);
    const before = snapshot();
    await commitBotProfileDeletion({ botId: 'bot-1', sessionIds: ['canonical', 'route'], keepTaskHistory: false });
    expect(sqlite.prepare("SELECT id FROM bot_profiles WHERE id = 'bot-1'").get()).toBeUndefined();
    expect(sqlite.prepare('SELECT * FROM bot_delegations').all()).toEqual([
      { id: 'shared-task', requesting_bot_id: 'bot-2', target_bot_id: 'bot-3' },
    ]);
    expect(snapshot().bot_direct_message_threads).toEqual(before.bot_direct_message_threads);
    expect(snapshot().bot_direct_messages).toEqual(before.bot_direct_messages);
  });

  it('deletes a Profile that has no task yet', async () => {
    await commitBotProfileDeletion({
      botId: 'bot-1',
      sessionIds: [],
      keepTaskHistory: false,
    });
    expect(sqlite.prepare("SELECT id FROM bot_profiles WHERE id = 'bot-1'").get()).toBeUndefined();
  });

  it('refuses a foreign task before changing the Profile or task', async () => {
    await expect(commitBotProfileDeletion({
      botId: 'bot-1',
      sessionIds: ['ordinary'],
      keepTaskHistory: false,
    })).rejects.toThrow('只能分离属于该 Bot 的任务');

    expect(sqlite.prepare("SELECT status FROM bot_profiles WHERE id = 'bot-1'").get())
      .toEqual({ status: 'archived' });
    expect(sqlite.prepare("SELECT id FROM media_refs WHERE id = 'avatar-ref'").get())
      .toEqual({ id: 'avatar-ref' });
    expect(sqlite.prepare("SELECT source, status FROM sessions WHERE id = 'ordinary'").get())
      .toEqual({ source: 'desktop', status: 'active' });
  });
});
