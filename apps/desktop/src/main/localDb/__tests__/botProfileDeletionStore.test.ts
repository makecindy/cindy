import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE bot_session_links (bot_id TEXT NOT NULL, session_id TEXT NOT NULL);
      INSERT INTO bot_profiles VALUES ('bot-1', 'archived');
      INSERT INTO sessions VALUES
        ('canonical', 'bot', 'archived', 1),
        ('route', 'bot', 'archived', 1),
        ('ordinary', 'desktop', 'active', 1);
      INSERT INTO bot_session_links VALUES
        ('bot-1', 'canonical'),
        ('bot-1', 'route');
    `);
    const db = drizzle(sqlite);
    h.db = db;
    h.tx = async (name, args) => runWorkerTx(sqlite, { name: name as never, args } as never);
  });

  it('atomically detaches kept transcripts and removes the Profile', async () => {
    await commitBotProfileDeletion({
      botId: 'bot-1',
      sessionIds: ['canonical', 'route', 'canonical'],
      keepTaskHistory: true,
    });

    expect(sqlite.prepare("SELECT id FROM bot_profiles WHERE id = 'bot-1'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT source, status FROM sessions WHERE id = 'canonical'").get())
      .toEqual({ source: 'desktop', status: 'archived' });
    expect(sqlite.prepare("SELECT source, status FROM sessions WHERE id = 'route'").get())
      .toEqual({ source: 'desktop', status: 'archived' });
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
    expect(sqlite.prepare("SELECT source, status FROM sessions WHERE id = 'ordinary'").get())
      .toEqual({ source: 'desktop', status: 'active' });
  });
});
