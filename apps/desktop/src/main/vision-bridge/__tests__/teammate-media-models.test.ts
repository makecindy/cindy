import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSessionMediaModels, readSessionVisionSettings } from '../teammate-media-models.js';

const state = vi.hoisted(() => ({ snapshot: null as { client: { drizzle: unknown }; userId: string; clientEpoch: number } | null, boundary: false }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => state.snapshot }));
vi.mock('../../appSessionState.js', () => ({ isAppSessionBoundaryPending: () => state.boundary }));
vi.mock('../vision-bridge-settings-store.js', () => ({ readVisionBridgeSettings: () => ({ enabled: false, targetModels: ['text'], primary: null, fallback: null }) }));

// New feature contract: actual production joins must use the session's real owner/current profile,
// survive profile reloads/reset, and reject an account change. Existing bridge tests inject settings
// and cannot verify ownership. Unit tier uses one in-memory DB, no filesystem/migrations/accounts.
const sqlite = new Database(':memory:');
sqlite.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT);
  CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, current_version INTEGER);
  CREATE TABLE bot_profile_versions (bot_id TEXT, version INTEGER, capabilities_json TEXT);
  CREATE TABLE bot_session_links (session_id TEXT, bot_id TEXT, archived_at INTEGER);`);
const primary = { providerId: 'vision-account', modelId: 'vision' };
const a = { vision: { primary, fallback: null }, image: { providerId: 'images-a', modelId: 'same-id' } };
const b = { image: { providerId: 'images-b', modelId: 'same-id' } };
beforeEach(() => {
  sqlite.exec('DELETE FROM sessions; DELETE FROM bot_profiles; DELETE FROM bot_profile_versions; DELETE FROM bot_session_links;');
  state.snapshot = { client: { drizzle: drizzle(sqlite) }, userId: 'owner', clientEpoch: 1 };
  state.boundary = false;
  for (const [id, mediaModels] of [['a', a], ['b', b]] as const) {
    sqlite.prepare('INSERT INTO bot_profiles VALUES (?, 1)').run(id);
    sqlite.prepare('INSERT INTO bot_profile_versions VALUES (?, 1, ?)').run(id, JSON.stringify({ mediaModels }));
    sqlite.prepare('INSERT INTO sessions VALUES (?, ?)').run(id, 'bot');
    sqlite.prepare('INSERT INTO bot_session_links VALUES (?, ?, NULL)').run(id, id);
  }
});
afterAll(() => sqlite.close());

describe('session-owned media model resolution', () => {
  it('separates teammates even when model IDs match and follows ownership for group/channel lanes', async () => {
    const first = await readSessionMediaModels('a');
    const second = await readSessionMediaModels('b');
    expect(first.overrides).toEqual(a);
    expect(second.overrides).toEqual(b);
    expect(first.scope).not.toBe(second.scope);
    sqlite.prepare('INSERT INTO sessions VALUES (?, ?)').run('group-lane', 'bot');
    sqlite.prepare('INSERT INTO bot_session_links VALUES (?, ?, NULL)').run('group-lane', 'a');
    expect(await readSessionMediaModels('group-lane')).toEqual(first);
    expect((await readSessionMediaModels('invented-bot-id')).overrides).toBeNull();
  });
  it('preserves ordinary tasks and archived links without inferring a teammate', async () => {
    sqlite.prepare('UPDATE sessions SET source = ? WHERE id = ?').run('desktop', 'a');
    sqlite.prepare('UPDATE bot_session_links SET archived_at = 1 WHERE session_id = ?').run('b');
    expect((await readSessionMediaModels('a')).overrides).toBeNull();
    expect((await readSessionMediaModels('b')).overrides).toBeNull();
    expect(await readSessionMediaModels()).toEqual({ scope: '', overrides: null });
  });
  it('reads persisted new profile versions and reset on reused sessions without changing other teammates', async () => {
    await readSessionMediaModels('a');
    sqlite.prepare('INSERT INTO bot_profile_versions VALUES (?, 2, ?)').run('a', JSON.stringify({ mediaModels: { video: { providerId: 'movies', modelId: 'video' } } }));
    sqlite.prepare('UPDATE bot_profiles SET current_version = 2 WHERE id = ?').run('a');
    expect((await readSessionMediaModels('a')).overrides).toEqual({ video: { providerId: 'movies', modelId: 'video' } });
    sqlite.prepare('UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ? AND version = 2').run('{}', 'a');
    expect((await readSessionMediaModels('a')).overrides).toBeNull();
    expect((await readSessionMediaModels('b')).overrides).toEqual(b);
  });
  it('merges only backend choices, leaving the app disabled and target models intact', async () => {
    expect((await readSessionVisionSettings('a')).settings).toEqual({ enabled: false, targetModels: ['text'], primary, fallback: null });
  });
  it('rejects in-flight account replacement and pending ownership boundaries', async () => {
    const pending = readSessionMediaModels('a');
    state.snapshot = { ...state.snapshot!, userId: 'other-owner', clientEpoch: 2 };
    await expect(pending).rejects.toThrow('owner changed');
    state.boundary = true;
    await expect(readSessionMediaModels('b')).rejects.toThrow('owner changed');
    state.boundary = false; state.snapshot = null;
    await expect(readSessionMediaModels('b')).rejects.toThrow('owner unavailable');
  });
});
