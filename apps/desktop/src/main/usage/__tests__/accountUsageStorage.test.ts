/** Unit: production storage boundary with in-memory DbClients. The old paths only persisted
 * CLI-default Claude / provider-scoped Codex. Cover account/owner isolation, legacy fallback,
 * and write-clear races through observable stored/read values, plus one real SQLite roundtrip.
 * No native login or user database is used. */
import { beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const h = vi.hoisted(() => ({
  owner: 'a', epoch: 0, boundary: false,
  rows: new Map<string, Map<string, string>>(),
  beforeWrite: undefined as undefined | (() => Promise<void>),
  sql: undefined as DatabaseSync | undefined,
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `${h.owner}:${h.epoch}`,
  isAppSessionBoundaryPending: () => h.boundary,
}));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientUserId: () => h.owner,
  getDbClient: () => {
    if (h.sql) {
      const db = h.sql;
      return {
        queryOne: async (sql: string, args: string[]) => db.prepare(sql).get(...args) ?? null,
        exec: async (sql: string, args: Array<string | number>) => { db.prepare(sql).run(...args); },
      };
    }
    const owner = h.owner;
    const rows = h.rows.get(owner) ?? new Map<string, string>();
    h.rows.set(owner, rows);
    return {
      queryOne: async (_sql: string, [key]: string[]) => rows.has(key) ? { snapshot: rows.get(key) } : null,
      exec: async (_sql: string, [key, json]: string[]) => {
        await h.beforeWrite?.();
        rows.set(key, json);
      },
    };
  },
}));
import { readStoredAccountUsage as read, writeStoredAccountUsage as write,
  readStoredLegacyAccountUsage as readLegacy, writeStoredLegacyAccountUsage as writeLegacy,
} from '../accountUsageStorage.js';
beforeEach(() => {
  h.owner = 'a'; h.epoch++; h.boundary = false; h.rows.clear(); h.beforeWrite = undefined; h.sql = undefined;
});

// Unit: the map-backed cases cannot prove valid SQL or durable bytes. Use the production writer
// against an isolated SQLite file, close/reopen it, and inspect the actual persisted account rows.
it('writes every account to SQLite and reads the same tiers after reopening the database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cindy-account-quota-test-'));
  const filename = join(directory, 'quota.db');
  try {
    h.sql = new DatabaseSync(filename);
    h.sql.exec('CREATE TABLE account_usage_snapshots (agent_kind TEXT PRIMARY KEY, snapshot TEXT, updated_at INTEGER NOT NULL)');
    for (const id of ['default', 'second']) {
      await write('anthropic', id, { used: id === 'second' ? 42 : 12, planTier: 'max_20x' });
      await write('openai', id, { used: id === 'second' ? 63 : 23, planType: 'plus' });
    }
    h.sql.close();
    h.sql = new DatabaseSync(filename);
    expect(h.sql.prepare('SELECT agent_kind FROM account_usage_snapshots ORDER BY agent_kind').all()
      .map(row => row.agent_kind)).toEqual(['claude-code:default', 'claude-code:second', 'codex:default', 'codex:second']);
    expect(await read('anthropic', 'second')).toEqual({ used: 42, planTier: 'max_20x' });
    expect(await read('openai', 'second')).toEqual({ used: 63, planType: 'plus' });
  } finally {
    h.sql?.close(); h.sql = undefined;
    rmSync(directory, { recursive: true, force: true });
  }
});

it('isolates both providers, accounts and Cindy owners', async () => {
  await write('anthropic', 'one', { used: 10, planTier: 'max_20x' });
  await write('anthropic', 'two', { used: 20 });
  await write('openai', 'one', { used: 30, planType: 'plus' });
  h.owner = 'b';
  expect(await read('anthropic', 'one')).toBeNull();
  await write('anthropic', 'one', { used: 40 });
  h.owner = 'a';
  expect(await read('anthropic', 'one')).toEqual({ used: 10, planTier: 'max_20x' });
  expect(await read('anthropic', 'two')).toEqual({ used: 20 });
  expect(await read('openai', 'one')).toEqual({ used: 30, planType: 'plus' });
});

// Unit: old broadcaster and pool shared a key but the old writer erased the pool identity.
// The real queue must preserve both sources in either order, including their distinct clears.
it.each(['anthropic', 'openai'] as const)('keeps verified and legacy %s observations independent in one account row', async provider => {
  const verified = { accountFingerprint: 'account-a', used: 12, planType: 'plus' };
  await Promise.all([write(provider, 'one', verified), writeLegacy(provider, 'one', { used: 42 })]);
  expect(await read(provider, 'one')).toEqual(verified);
  expect(await readLegacy(provider, 'one')).toEqual({ used: 42 });
  await writeLegacy(provider, 'one', null);
  expect(await read(provider, 'one')).toEqual(verified);
  expect(await readLegacy(provider, 'one')).toBeNull();
  await Promise.all([writeLegacy(provider, 'one', { used: 77 }), write(provider, 'one', { ...verified, used: 18 })]);
  expect(await read(provider, 'one')).toEqual({ ...verified, used: 18 });
  expect(await readLegacy(provider, 'one')).toEqual({ used: 77 });
  await write(provider, 'one', { ...verified, accountFingerprint: 'account-b' });
  expect(await readLegacy(provider, 'one')).toEqual({ ...verified, accountFingerprint: 'account-b' });
  await write(provider, 'one', null);
  expect(await readLegacy(provider, 'one')).toBeNull();
  await writeLegacy(provider, 'one', verified);
  expect(await read(provider, 'one')).toBeNull(); // legacy cannot promote its old digest to proof
  expect(await readLegacy(provider, 'one')).toEqual(verified);
});

it('reads legacy data, then prefers account storage and keeps a cleared account cleared', async () => {
  h.rows.set('a', new Map([['claude-code', '{"used":12}']]));
  expect(await read('anthropic', 'default', ['claude-code'])).toEqual({ used: 12 });
  await write('anthropic', 'default', { used: 24 });
  expect(await read('anthropic', 'default', ['claude-code'])).toEqual({ used: 24 });
  await write('anthropic', 'default', null);
  expect(await read('anthropic', 'default', ['claude-code'])).toBeNull();
  expect(h.rows.get('a')?.get('claude-code')).toBe('{"used":12}');
});

it.each([false, true])('preserves removal after an executing write (write fails=%s)', async fails => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.beforeWrite = async () => { started(); await gate; if (fails) throw new Error('busy'); };
  const first = write('openai', 'one', { used: 25 });
  await entered;
  const clear = write('openai', 'one', null);
  const stale = write('openai', 'one', { used: 90 }, () => false);
  h.beforeWrite = undefined;
  release();
  const results = await Promise.allSettled([first, clear, stale]);
  expect(results.every(result => result.status === (fails ? 'rejected' : 'fulfilled'))).toBe(true);
  expect(await read('openai', 'one')).toBeNull();
});

it('does not write a queued snapshot after owner change, removal or a login boundary', async () => {
  const old = write('openai', 'one', { used: 25 });
  h.owner = 'b';
  await old;
  expect(h.rows.get('a')?.size).toBe(0);
  expect(await read('openai', 'one')).toBeNull();
  await write('openai', 'one', { used: 50 }, () => false);
  h.boundary = true;
  await write('openai', 'one', { used: 75 });
  h.boundary = false;
  expect(await read('openai', 'one')).toBeNull();
});

it('replaces corrupt snapshots without falling back to older account data', async () => {
  h.rows.set('a', new Map([['codex:one', '[broken'], ['codex:old', '{"used":99}']]));
  expect(await read('openai', 'one', ['codex:old'])).toBeNull();
  await write('openai', 'one', { used: 1 });
  expect(await read('openai', 'one')).toEqual({ used: 1 });
});
