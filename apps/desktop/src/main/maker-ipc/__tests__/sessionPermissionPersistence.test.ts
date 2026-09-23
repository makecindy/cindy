import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

import { persistPermissionModeWithoutRuntime, profilePermissionForSessionMode } from '../sessionPermissionPersistence.js';

function createDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      permission_mode TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY,
      current_version INTEGER NOT NULL
    );
    CREATE TABLE bot_session_links (
      bot_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE bot_profile_versions (
      bot_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      capabilities_json TEXT NOT NULL
    );
    INSERT INTO sessions VALUES ('chat', 'ask', 1);
    INSERT INTO bot_profiles VALUES ('bot-1', 2);
    INSERT INTO bot_session_links VALUES ('bot-1', 'chat', 'canonical', NULL);
    INSERT INTO bot_profile_versions VALUES ('bot-1', 2, '{"permissions":"ask","memory":true}');
  `);
  return sqlite;
}

describe('permission persistence without a live runtime', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = createDatabase();
    h.db = drizzle(sqlite);
  });

  it('maps only the teammate permission values', () => {
    expect(profilePermissionForSessionMode('bypassPermissions')).toBe('trusted');
    expect(profilePermissionForSessionMode('acceptEdits')).toBeNull();
  });

  it('writes the session and the canonical profile together', async () => {
    await expect(persistPermissionModeWithoutRuntime('chat', 'auto')).resolves.toBe(true);
    expect(sqlite.prepare('SELECT permission_mode FROM sessions WHERE id = ?').pluck().get('chat')).toBe('auto');
    expect(JSON.parse(sqlite.prepare('SELECT capabilities_json FROM bot_profile_versions').pluck().get() as string))
      .toMatchObject({ permissions: 'auto', memory: true });
  });

  it('does not report success when the session row is missing', async () => {
    await expect(persistPermissionModeWithoutRuntime('missing', 'ask')).resolves.toBe(false);
    expect(sqlite.prepare('SELECT permission_mode FROM sessions').pluck().get()).toBe('ask');
  });
});
