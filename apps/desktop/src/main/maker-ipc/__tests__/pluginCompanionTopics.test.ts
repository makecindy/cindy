import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { createPluginTargetStore } from '../pluginTargetStore.js';
import { createPluginTaskStore } from '../pluginTaskStore.js';
import { resolvePluginCompanionTopic } from '../pluginCompanionTopics.js';

const h = vi.hoisted(() => ({
  owner: null as { client: DbClient } | null,
  ensure: vi.fn(), find: vi.fn(), noteHidden: vi.fn(),
}));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => h.owner }));
vi.mock('../../localDb/ipc/bots.js', () => ({ ensureBotChannelLaneSession: h.ensure, findBotChannelLaneSession: h.find }));
vi.mock('../../localDb/sessionFlagRegistry.js', () => ({ noteSessionHidden: h.noteHidden }));

// Unit: real receipt SQL + production topic resolver and lifecycle store. The
// existing slot tests cannot detect a lost binding or source/uninstall takeover.
// Minimal input: one (plugin, companion, topic) mapping; no user DB or network.
let sqlite: Database.Database;
let client: DbClient;
let lanes: Map<string, string>;
const options = { create: true, title: 'Question', assertCurrent: () => {} };
beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE plugin_task_requests (
    id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, operation TEXT NOT NULL,
    target_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
    payload TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(plugin_id,operation,target_id,request_key));`);
  client = { drizzle: drizzle(sqlite) } as unknown as DbClient;
  h.owner = { client };
  lanes = new Map();
  h.noteHidden.mockClear();
  h.ensure.mockReset().mockImplementation(async ({ botId, routeKey }) => {
    const key = JSON.stringify([botId, routeKey]);
    const created = !lanes.has(key);
    if (created) lanes.set(key, `lane-${lanes.size}`);
    return { ok: true, created, sessionId: lanes.get(key) };
  });
  h.find.mockReset().mockImplementation(async (botId, routeKey) => lanes.get(JSON.stringify([botId, routeKey])) ?? null);
});
afterEach(() => { h.owner = null; sqlite.close(); });

it('persists isolated bindings and reuses the native companion lane without ordinary task ownership', async () => {
  const [first, simultaneous] = await Promise.all([
    resolvePluginCompanionTopic('plugin', 'bot', 'topic', options),
    resolvePluginCompanionTopic('plugin', 'bot', 'topic', options),
  ]);
  expect(simultaneous).toBe(first);
  expect(await resolvePluginCompanionTopic('plugin', 'bot', 'topic', { ...options, create: false })).toBe(first);
  // A fresh store/owner snapshot after restart has no in-memory routing state.
  h.owner = { client };
  expect(await resolvePluginCompanionTopic('plugin', 'bot', 'topic', options)).toBe(first);
  const others = await Promise.all([
    resolvePluginCompanionTopic('plugin', 'bot', 'other-topic', options),
    resolvePluginCompanionTopic('other-plugin', 'bot', 'topic', options),
    resolvePluginCompanionTopic('plugin', 'other-bot', 'topic', options),
  ]);
  expect(new Set([first, ...others]).size).toBe(4);
  expect(sqlite.prepare('SELECT count(*) FROM plugin_task_requests').pluck().get()).toBe(4);
  expect(await createPluginTargetStore(client, () => {}).get('plugin', 'topic')).toBeUndefined();
  expect(await createPluginTaskStore(client).list('plugin', 'create', null, '', 10)).toEqual([]);
  expect(h.noteHidden).toHaveBeenCalledTimes(4);
});

it('does not create a missing binding or replace a lost lane while validating a restored queue', async () => {
  await expect(resolvePluginCompanionTopic('plugin', 'bot', 'topic', { ...options, create: false }))
    .rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  expect(sqlite.prepare('SELECT count(*) FROM plugin_task_requests').pluck().get()).toBe(0);
  await resolvePluginCompanionTopic('plugin', 'bot', 'topic', options);
  h.ensure.mockClear(); lanes.clear();
  await expect(resolvePluginCompanionTopic('plugin', 'bot', 'topic', { ...options, create: false }))
    .rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  expect(h.ensure).not.toHaveBeenCalled();
});

it.each(['uninstall', 'change source'] as const)('does not let a replacement installation inherit topics after %s', async change => {
  const first = await resolvePluginCompanionTopic('plugin', 'bot', 'topic', options);
  const store = createPluginTaskStore(client);
  if (change === 'uninstall') {
    await store.revokePlugin('plugin');
    await expect(resolvePluginCompanionTopic('plugin', 'bot', 'topic', options))
      .rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
    expect(lanes.size).toBe(1);
  } else {
    await store.relocatePlugin('plugin', 'archived-source');
    expect(await resolvePluginCompanionTopic('plugin', 'bot', 'topic', options)).not.toBe(first);
    expect(lanes.size).toBe(2);
  }
});

it('rejects an account switch or revoked approval before returning a lane', async () => {
  const owner = h.owner;
  h.ensure.mockImplementationOnce(async () => {
    h.owner = { client };
    return { ok: true, created: true, sessionId: 'late' };
  });
  await expect(resolvePluginCompanionTopic('plugin', 'bot', 'topic', options))
    .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(h.noteHidden).not.toHaveBeenCalled();
  h.owner = owner;
  const denied = { ...options, assertCurrent: () => { throw Object.assign(new Error('revoked'), { code: 'PERMISSION_DENIED' }); } };
  await expect(resolvePluginCompanionTopic('plugin', 'bot', 'new-topic', denied))
    .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(sqlite.prepare('SELECT count(*) FROM plugin_task_requests').pluck().get()).toBe(1);
});
