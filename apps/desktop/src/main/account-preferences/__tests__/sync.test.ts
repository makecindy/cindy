/**
 * Unit: public store and driver entrances verify durable saves, owner/peer revocation fences and
 * offline reconciliation. New account-preference replicas have no existing persistence/transport tests.
 * Minimal failures: account changes while waiting for a lock; reset meets an old peer; second account
 * attempts to import the same unscoped renderer values. Files are unique os.tmpdir fixtures.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeAccountPreferencesStates, type AccountPreferencesState, type AccountPreferencesSyncFrame } from '@cindy/device-link';

const h = vi.hoisted(() => ({ root: '', owner: 'a', generation: 1, boundary: false, beforeLock: undefined as (() => void) | undefined }));
vi.mock('electron', () => ({ app: { getPath: () => h.root } }));
vi.mock('../../appSessionState.js', () => ({
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: h.owner, ownerGeneration: h.generation }),
  getActiveAppSession: () => ({ dataOwnerId: h.owner, generation: h.generation, mode: 'cloud' }),
  activeOwnerScopeKey: () => `${h.owner}:${h.generation}`,
  isAppSessionBoundaryPending: () => h.boundary,
  ownerScopedUserDataPath: (...parts: string[]) => path.join(h.root, h.owner, ...parts),
  onAppSessionInvalidated: () => () => {},
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../device-link/crossProcessLock.js', () => ({
  withCrossProcessLock: async (_path: string, _options: unknown, task: (status: { held: true }) => Promise<unknown>) => {
    h.beforeLock?.();
    return task({ held: true });
  },
}));

import {
  importLegacyAccountPreferences,
  loadAccountPreferencesSnapshot,
  mergeAccountPreferencesSyncState,
  onAccountPreferencesChanged,
  readAccountPreferencesSyncState,
  setAccountPreference,
} from '../store.js';
import { createAccountPreferencesSyncDriver } from '../driver.js';

const stamp = () => ({ dataOwnerId: h.owner, ownerGeneration: h.generation });
const remote = (counter = 4): AccountPreferencesState => ({
  version: 1, fields: { language: { value: 'ja', counter, nodeId: 'peer' } },
});
const cleanups: Array<() => void> = [];

beforeEach(() => {
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-account-preferences-'));
  h.owner = 'a'; h.generation = 1; h.boundary = false; h.beforeLock = undefined;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe('account preferences durable store', () => {
  it('persists independent remote/local changes, advances revisions and keeps reset tombstones', async () => {
    const changes = vi.fn();
    cleanups.push(onAccountPreferencesChanged(changes));
    await setAccountPreference({ ...stamp(), key: 'theme', value: 'dark' });
    await mergeAccountPreferencesSyncState(remote());
    const beforeReset = readAccountPreferencesSyncState();
    const snapshot = await setAccountPreference({ ...stamp(), key: 'theme', value: null });
    expect(snapshot.values).toEqual({ theme: null, language: 'ja' });
    expect(readAccountPreferencesSyncState().fields.theme?.counter).toBe(5);
    expect(await mergeAccountPreferencesSyncState(beforeReset)).toBe(false);
    const stored = JSON.parse(fs.readFileSync(path.join(h.root, h.owner, 'account-preferences.json'), 'utf8'));
    expect(stored.state).toEqual(readAccountPreferencesSyncState());
    expect(stored.counter).toBe(5);
    expect(changes.mock.calls.map(([change]) => change.origin)).toEqual(['local', 'remote', 'local']);
  });

  it('claims legacy values once for one owner and never overwrites synchronized fields or tombstones', async () => {
    await mergeAccountPreferencesSyncState(remote());
    await setAccountPreference({ ...stamp(), key: 'theme', value: null });
    const imported = await importLegacyAccountPreferences({ ...stamp(), values: { theme: 'dark', language: 'en', 'sidebar.cardMode': 'card' } });
    expect(imported.values).toEqual({ theme: null, language: 'ja', 'sidebar.cardMode': 'card' });
    expect(imported.legacyImportAllowed).toBe(false);
    const repeated = await importLegacyAccountPreferences({ ...stamp(), values: { 'sidebar.mainListMode': 'text' } });
    expect(repeated.values).toEqual(imported.values);
    h.owner = 'b'; h.generation += 1;
    expect(loadAccountPreferencesSnapshot().legacyImportAllowed).toBe(false);
    expect((await importLegacyAccountPreferences({ ...stamp(), values: { theme: 'dark' } })).values).toEqual({});
  });

  it('rejects invalid input and account changes before writes, and refuses a peer revoked while waiting', async () => {
    await expect(setAccountPreference({ ...stamp(), key: 'apiKey', value: 'never' } as never)).rejects.toThrow('[INVALID_PARAMS]');
    await expect(setAccountPreference({ ...stamp(), key: 'theme', value: 'invalid' })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(setAccountPreference({ ...stamp(), ownerGeneration: 5, key: 'theme', value: 'dark' })).rejects.toThrow('[PRECONDITION_FAILED]');
    h.beforeLock = () => { h.owner = 'b'; h.generation += 1; };
    await expect(setAccountPreference({ ...stamp(), key: 'theme', value: 'dark' })).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(fs.existsSync(path.join(h.root, 'b', 'account-preferences.json'))).toBe(false);
    let allowed = true;
    h.beforeLock = () => { allowed = false; };
    expect(await mergeAccountPreferencesSyncState(remote(), () => allowed)).toBe(false);
    expect(fs.existsSync(path.join(h.root, 'b', 'account-preferences.json'))).toBe(false);
  });

  it('preserves unsupported stored versions instead of interpreting them as empty settings', async () => {
    const filePath = path.join(h.root, h.owner, 'account-preferences.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const contents = '{"version":2,"future":"preserve"}';
    fs.writeFileSync(filePath, contents);
    expect(() => loadAccountPreferencesSnapshot()).toThrow('[PRECONDITION_FAILED]');
    await expect(setAccountPreference({ ...stamp(), key: 'theme', value: 'dark' })).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(contents);
  });

  it('does not report an already durable edit as failed when a view listener throws', async () => {
    cleanups.push(onAccountPreferencesChanged(() => { throw new Error('window closed'); }));
    await expect(setAccountPreference({ ...stamp(), key: 'theme', value: 'dark' })).resolves.toMatchObject({ values: { theme: 'dark' } });
    expect(loadAccountPreferencesSnapshot().values).toEqual({ theme: 'dark' });
  });
});

describe('account preferences sync driver', () => {
  function fixture(initiallyReady = true) {
    let state: AccountPreferencesState = { version: 1, fields: {} };
    let scope = 'a:1';
    let allowed = true;
    let ready = initiallyReady;
    let changed: (() => void) | undefined;
    let invalidated: (() => void) | undefined;
    const sent: Array<{ peer: string; frame: AccountPreferencesSyncFrame }> = [];
    const merge = vi.fn(async (incoming: AccountPreferencesState, isCurrent: () => boolean) => {
      if (!isCurrent()) return false;
      const result = mergeAccountPreferencesStates(state, incoming);
      state = result.state;
      if (result.changed) changed?.();
      return result.changed;
    });
    const driver = createAccountPreferencesSyncDriver({
      owner: () => ({ dataOwnerId: 'a', scope, enabled: true }),
      readState: () => state,
      mergeState: merge,
      subscribe: listener => { changed = listener; return () => { changed = undefined; }; },
      canSendState: () => ready,
      onInvalidated: listener => { invalidated = listener; return () => { invalidated = undefined; }; },
    });
    const transport = { peers: () => ['peer'], allowed: () => allowed, send: (peer: string, frame: AccountPreferencesSyncFrame) => { sent.push({ peer, frame }); } };
    driver.connect(transport);
    cleanups.push(driver.stop);
    return { driver, sent, merge, changed: () => changed?.(), state: () => state, revoke: () => { allowed = false; },
      switchOwner: () => { scope = 'b:2'; },
      nextGeneration: () => { invalidated?.(); scope = 'a:2'; },
      reconnect: () => driver.connect(transport),
      ready: () => { ready = true; changed?.(); },
    };
  }

  it('requests a snapshot on connect/peer online and replies once to a duplicate reply request', async () => {
    const f = fixture();
    expect(f.sent[0].frame.requestReply).toBe(true);
    await f.driver.receive('peer', { version: 1, dataOwnerId: 'a', state: remote(), requestReply: true });
    expect(f.state().fields.language?.value).toBe('ja');
    expect(f.sent.at(-1)?.frame.requestReply).toBeUndefined();
    const count = f.sent.length;
    await f.driver.receive('peer', { version: 1, dataOwnerId: 'a', state: remote() });
    expect(f.sent).toHaveLength(count);
    f.driver.peerOnline('peer');
    expect(f.sent.at(-1)?.frame.requestReply).toBe(true);
  });

  it('ignores wrong-account, newer-version and revoked peers before any merge', async () => {
    const f = fixture();
    await f.driver.receive('peer', { version: 1, dataOwnerId: 'other', state: remote() });
    await f.driver.receive('peer', { version: 2, dataOwnerId: 'a', state: remote() });
    f.revoke();
    await f.driver.receive('peer', { version: 1, dataOwnerId: 'a', state: remote() });
    f.driver.peerOnline('peer');
    expect(f.merge).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(1);
  });

  it('coalesces edits and cancels pending old-owner broadcasts on scope change or stop', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.changed(); f.changed();
    await vi.advanceTimersByTimeAsync(150);
    expect(f.sent).toHaveLength(2);
    f.changed(); f.switchOwner();
    await vi.advanceTimersByTimeAsync(150);
    expect(f.sent).toHaveLength(2);
    f.driver.stop();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(f.sent).toHaveLength(2);
  });

  it('rebinds the same owner after invalidation and resumes exchanges after stop/connect', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.changed();
    f.nextGeneration();
    await vi.advanceTimersByTimeAsync(150);
    expect(f.sent).toHaveLength(1);
    f.reconnect();
    expect(f.sent).toHaveLength(2);
    f.changed();
    await vi.advanceTimersByTimeAsync(150);
    expect(f.sent).toHaveLength(3);
    f.driver.stop();
    f.reconnect();
    await f.driver.receive('peer', { version: 1, dataOwnerId: 'a', state: remote() });
    expect(f.state().fields.language?.value).toBe('ja');
    expect(f.sent.at(-1)?.frame.requestReply).toBeUndefined();
  });

  it('holds outgoing empty snapshots until legacy import settles while still accepting remote edits', async () => {
    vi.useFakeTimers();
    const f = fixture(false);
    expect(f.sent).toHaveLength(0);
    await f.driver.receive('peer', { version: 1, dataOwnerId: 'a', state: remote(), requestReply: true });
    expect(f.state().fields.language?.value).toBe('ja');
    await vi.advanceTimersByTimeAsync(150);
    expect(f.sent).toHaveLength(0);
    f.ready();
    await vi.advanceTimersByTimeAsync(150);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].frame.state.fields.language?.value).toBe('ja');
  });
});
