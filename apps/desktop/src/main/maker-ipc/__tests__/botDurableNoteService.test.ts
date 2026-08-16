import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as Database.Database | null,
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

import {
  deleteBotDurableNote,
  getBotDurableNote,
  listBotDurableNotes,
  setBotDurableNote,
} from '../botDurableNoteService.js';

describe('botDurableNoteService', () => {
  beforeEach(() => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE bot_session_links (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        profile_version INTEGER NOT NULL DEFAULT 1,
        role TEXT NOT NULL DEFAULT 'canonical',
        channel_id TEXT,
        route_key TEXT,
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE TABLE bot_durable_notes (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        note_key TEXT NOT NULL,
        value_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(bot_id, namespace, note_key)
      );
      CREATE TABLE bot_automation_links (
        id TEXT PRIMARY KEY,
        durable_note_namespace TEXT
      );
      CREATE TABLE bot_automation_runs (
        id TEXT PRIMARY KEY,
        automation_link_id TEXT NOT NULL,
        session_id TEXT
      );
      INSERT INTO sessions (id, source) VALUES
        ('a-main', 'bot'), ('b-main', 'bot'), ('ordinary', 'desktop');
      INSERT INTO bot_session_links (id, bot_id, session_id, created_at)
      VALUES ('a:a-main', 'bot-a', 'a-main', 1), ('b:b-main', 'bot-b', 'b-main', 1);
    `);
    h.sqlite = sqlite;
    h.db = drizzle(sqlite);
  });

  it('persists JSON per Bot and prevents cross-Bot reads', async () => {
    const saved = await setBotDurableNote({
      callerSessionId: 'a-main',
      namespace: 'automation',
      key: 'cursor',
      value: { page: 2 },
    });
    expect(saved).toMatchObject({ ok: true, note: { value: { page: 2 } } });
    expect(await listBotDurableNotes({ callerSessionId: 'a-main' })).toMatchObject({
      ok: true,
      notes: [{ namespace: 'automation', key: 'cursor', value: { page: 2 } }],
    });
    expect(await getBotDurableNote({
      callerSessionId: 'b-main',
      namespace: 'automation',
      key: 'cursor',
    })).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    expect(await getBotDurableNote({
      callerSessionId: 'ordinary',
      namespace: 'automation',
      key: 'cursor',
    })).toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
  });

  it('enforces key and value bounds and supports deletion', async () => {
    expect(await setBotDurableNote({
      callerSessionId: 'a-main',
      namespace: '../escape',
      key: 'x',
      value: true,
    })).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(await setBotDurableNote({
      callerSessionId: 'a-main',
      namespace: 'automation',
      key: 'large',
      value: 'x'.repeat(40_000),
    })).toMatchObject({ ok: false, errorCode: 'VALUE_TOO_LARGE' });
    await setBotDurableNote({
      callerSessionId: 'a-main',
      namespace: 'automation',
      key: 'cursor',
      value: 1,
    });
    expect(await deleteBotDurableNote({
      callerSessionId: 'a-main',
      namespace: 'automation',
      key: 'cursor',
    })).toEqual({ ok: true, deleted: true });
  });

  it('uses the automation-bound namespace when the tool omits one', async () => {
    h.sqlite!.exec(`
      INSERT INTO sessions (id, source) VALUES ('a-automation', 'bot');
      INSERT INTO bot_session_links (id, bot_id, session_id, created_at)
      VALUES ('a:a-automation', 'bot-a', 'a-automation', 2);
      INSERT INTO bot_automation_links VALUES ('automation-a', 'nightly');
      INSERT INTO bot_automation_runs VALUES ('run-a', 'automation-a', 'a-automation');
    `);
    expect(await setBotDurableNote({
      callerSessionId: 'a-automation',
      key: 'cursor',
      value: 7,
    })).toMatchObject({ ok: true, note: { namespace: 'nightly', key: 'cursor', value: 7 } });
    await expect(setBotDurableNote({
      callerSessionId: 'a-automation',
      namespace: 'another-automation',
      key: 'cursor',
      value: 8,
    })).resolves.toMatchObject({ ok: false, errorCode: 'NAMESPACE_SCOPE_MISMATCH' });
    await expect(listBotDurableNotes({
      callerSessionId: 'a-automation',
      namespace: 'another-automation',
    })).resolves.toMatchObject({ ok: false, errorCode: 'NAMESPACE_SCOPE_MISMATCH' });
    await expect(getBotDurableNote({
      callerSessionId: 'a-main',
      namespace: 'nightly',
      key: 'cursor',
    })).resolves.toMatchObject({ ok: true, note: { value: 7 } });
  });

  it('fails closed when legacy Automation data contains an invalid bound namespace', async () => {
    h.sqlite!.exec(`
      INSERT INTO sessions (id, source) VALUES ('a-invalid-automation', 'bot');
      INSERT INTO bot_session_links (id, bot_id, session_id, created_at)
      VALUES ('a:a-invalid-automation', 'bot-a', 'a-invalid-automation', 3);
      INSERT INTO bot_automation_links VALUES ('automation-invalid', '../escape');
      INSERT INTO bot_automation_runs VALUES
        ('run-invalid', 'automation-invalid', 'a-invalid-automation');
    `);
    await expect(setBotDurableNote({
      callerSessionId: 'a-invalid-automation',
      key: 'cursor',
      value: 1,
    })).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  });

  it('rejects durable-state access from archived and read-only Bot history tasks', async () => {
    await setBotDurableNote({
      callerSessionId: 'a-main',
      namespace: 'automation',
      key: 'cursor',
      value: 1,
    });
    h.sqlite!.exec(`
      INSERT INTO sessions (id, source, status) VALUES
        ('a-archived', 'bot', 'archived'),
        ('a-history', 'bot', 'active');
      INSERT INTO bot_session_links (id, bot_id, session_id, role, created_at) VALUES
        ('a:a-archived', 'bot-a', 'a-archived', 'history', 3),
        ('a:a-history', 'bot-a', 'a-history', 'history', 4);
    `);

    await expect(setBotDurableNote({
      callerSessionId: 'a-archived',
      namespace: 'automation',
      key: 'cursor',
      value: 2,
    })).resolves.toMatchObject({ ok: false, errorCode: 'BOT_SESSION_INACTIVE' });
    await expect(deleteBotDurableNote({
      callerSessionId: 'a-history',
      namespace: 'automation',
      key: 'cursor',
    })).resolves.toMatchObject({ ok: false, errorCode: 'BOT_SESSION_READ_ONLY' });
    await expect(getBotDurableNote({
      callerSessionId: 'a-main',
      namespace: 'automation',
      key: 'cursor',
    })).resolves.toMatchObject({ ok: true, note: { value: 1 } });
  });
});
