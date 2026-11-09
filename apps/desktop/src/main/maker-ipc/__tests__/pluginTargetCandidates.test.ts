import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  snapshot: null as {
    client: { drizzle: ReturnType<typeof drizzle> }; userId: string; clientEpoch: number;
  } | null,
  shares: { active: true, ownerStamp: { dataOwnerId: 'owner-fixture', ownerGeneration: 1 },
    received: [] as { shareId: string; status: string }[] },
}));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => h.snapshot,
  getDbClient: () => h.snapshot!.client,
}));
vi.mock('../../localDb/ipc/recentWorkdirs.js', () => ({ listRecentWorkdirs: async () => [] }));
vi.mock('../../device-link/providerShareGuest.js', () => ({
  getReceivedSharesSnapshot: () => h.shares,
}));

import { listPluginTargetCandidates, resolvePluginTargetSession } from '../pluginTargetCandidates.js';
import * as canonical from '../botCanonicalSessionRegistry.js';

// unit: production SQL + canonical resolver. Existing Slot tests fake candidates,
// so they missed a local Bot whose agent_device_id is a received provider share.
// Minimal regression: active canonical + active share must resolve the same Session;
// a remote Session, revoked share, owner switch or ambiguous link must still fail.
describe('plugin Bot target ownership and execution location', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT DEFAULT 'Task', working_dir TEXT,
        status TEXT DEFAULT 'active', source TEXT DEFAULT 'desktop',
        remote_host_id TEXT, agent_device_id TEXT, hidden_at INTEGER,
        orca_role TEXT, user_send_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
      );
      CREATE TABLE bot_profiles (
        id TEXT PRIMARY KEY, display_name TEXT DEFAULT 'Companion',
        description TEXT DEFAULT '', status TEXT DEFAULT 'active', hidden_at INTEGER
      );
      CREATE TABLE bot_session_links (
        id TEXT PRIMARY KEY, bot_id TEXT, session_id TEXT, role TEXT, archived_at INTEGER
      );
    `);
    h.snapshot = { client: { drizzle: drizzle(db) }, userId: 'owner-fixture', clientEpoch: 1 };
    h.shares = { active: true, ownerStamp: { dataOwnerId: 'owner-fixture', ownerGeneration: 1 },
      received: [{ shareId: 'fixture-share', status: 'active' }] };
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  function seed(agentDeviceId: string | null = null) {
    db.prepare('INSERT INTO bot_profiles (id) VALUES (?)').run('companion');
    db.prepare("INSERT INTO sessions (id, source, agent_device_id) VALUES (?, 'bot', ?)")
      .run('canonical', agentDeviceId);
    db.prepare("INSERT INTO bot_session_links VALUES ('link', 'companion', 'canonical', 'canonical', NULL)").run();
  }

  it.each([null, 'share:fixture-share'])('resolves a local canonical using %s without exposing execution metadata', async route => {
    seed(route);
    expect(await listPluginTargetCandidates('bot')).toEqual([
      { id: 'companion', label: 'Companion', detail: '' },
    ]);
    await expect(resolvePluginTargetSession('bot', 'companion')).resolves.toBe('canonical');
    expect(await listPluginTargetCandidates('task')).toEqual([]);
  });

  it.each([
    "UPDATE bot_profiles SET hidden_at = 1",
    "UPDATE bot_profiles SET status = 'archived'",
    "UPDATE sessions SET hidden_at = 1",
    "UPDATE sessions SET status = 'archived'",
    "UPDATE bot_session_links SET archived_at = 1",
    "UPDATE sessions SET remote_host_id = 'remote-host'",
    "UPDATE sessions SET agent_device_id = 'another-device'",
    "UPDATE sessions SET agent_device_id = 'share:unknown'",
    "UPDATE sessions SET agent_device_id = 'share:'",
  ])('keeps inaccessible canonical targets out: %s', async change => {
    seed(); db.exec(change);
    expect(await listPluginTargetCandidates('bot')).toEqual([]);
    await expect(resolvePluginTargetSession('bot', 'companion')).rejects.toThrow('TARGET_UNAVAILABLE');
  });

  it.each(['paused', 'removed', 'owner-changed', 'wrong-owner'])('rechecks share authority on resolution: %s', async reason => {
    seed('share:fixture-share');
    expect(await listPluginTargetCandidates('bot')).toHaveLength(1);
    if (reason === 'paused') h.shares.received[0]!.status = 'paused';
    if (reason === 'removed') h.shares.received = [];
    if (reason === 'owner-changed') h.shares.active = false;
    if (reason === 'wrong-owner') h.shares.ownerStamp.dataOwnerId = 'other-owner';
    await expect(resolvePluginTargetSession('bot', 'companion')).rejects.toThrow('TARGET_UNAVAILABLE');
  });

  it.each([null, 'another-device', 'missing-session'])('rejects a second canonical even when its route is ineligible: %s', async route => {
    seed('share:fixture-share');
    if (route !== 'missing-session') db.prepare("INSERT INTO sessions (id, source, agent_device_id) VALUES ('second', 'bot', ?)").run(route);
    db.exec("INSERT INTO bot_session_links VALUES ('second-link', 'companion', 'second', 'canonical', NULL)");
    expect(await listPluginTargetCandidates('bot')).toEqual([]);
    await expect(resolvePluginTargetSession('bot', 'companion')).rejects.toThrow('TARGET_UNAVAILABLE');
  });

  it('does not read a different owner DB when the canonical registry resumes', async () => {
    seed();
    vi.spyOn(canonical, 'resolveBotCanonicalSession').mockImplementationOnce(async () => {
      h.snapshot = { ...h.snapshot!, userId: 'other-owner', clientEpoch: 2 };
      return { status: 'resolved', sessionId: 'canonical' };
    });
    await expect(resolvePluginTargetSession('bot', 'companion')).rejects.toThrow('PERMISSION_DENIED');
  });

  it('keeps ordinary task execution-location restrictions', async () => {
    db.exec(`INSERT INTO sessions (id) VALUES ('local-task');
      INSERT INTO sessions (id, agent_device_id) VALUES ('shared-task', 'share:fixture-share');
      INSERT INTO sessions (id, agent_device_id) VALUES ('remote-task', 'another-device');`);
    expect((await listPluginTargetCandidates('task')).map(row => row.id)).toEqual(['local-task']);
  });
});
