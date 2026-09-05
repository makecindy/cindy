import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

import { resolveBotCanonicalSession } from '../botCanonicalSessionRegistry.js';

describe('Bot canonical Session registry', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE bot_session_links (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        archived_at INTEGER
      );
    `);
    h.db = drizzle(sqlite);
  });

  it('resolves the canonical link and never consults a profile mirror', async () => {
    sqlite.prepare(
      "INSERT INTO bot_session_links VALUES ('canonical', 'bot-1', 'session-from-link', 'canonical', NULL)",
    ).run();

    await expect(resolveBotCanonicalSession('bot-1')).resolves.toEqual({
      status: 'resolved',
      sessionId: 'session-from-link',
    });
  });

  it('fails closed when the registry has no canonical link', async () => {
    await expect(resolveBotCanonicalSession('bot-1')).resolves.toEqual({
      status: 'missing',
      sessionId: null,
    });
  });

  it('fails closed when the only canonical link is archived', async () => {
    sqlite.prepare(
      "INSERT INTO bot_session_links VALUES ('canonical', 'bot-1', 'session-archived', 'canonical', 100)",
    ).run();

    await expect(resolveBotCanonicalSession('bot-1')).resolves.toEqual({
      status: 'missing',
      sessionId: null,
    });
  });

  it('fails closed instead of choosing when corrupt data has multiple canonical links', async () => {
    sqlite.exec(`
      INSERT INTO bot_session_links VALUES
        ('canonical-a', 'bot-1', 'session-a', 'canonical', NULL),
        ('canonical-b', 'bot-1', 'session-b', 'canonical', NULL);
    `);

    await expect(resolveBotCanonicalSession('bot-1')).resolves.toEqual({
      status: 'conflict',
      sessionId: null,
    });
  });
});
