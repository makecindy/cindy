/**
 * Claude account registry: pure state transitions plus the atomic JSON store.
 * The store runs against a real temp directory; no Electron, no CLI.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ClaudeAccountRegistryError,
  addAccount,
  createRegistryStore,
  emptyRegistry,
  parseRegistry,
  removeAccount,
  setActiveAccount,
  touchAccount,
  updateIdentity,
} from '../registry.js';
import { MASTER_ACCOUNT_ID } from '../types.js';

const NOW = 1_760_000_000_000;
let seq = 0;
const deps = { now: () => NOW, newId: () => `acct_test${String(++seq).padStart(4, '0')}` };

beforeEach(() => {
  seq = 0;
});

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof ClaudeAccountRegistryError ? err.code : 'not-a-registry-error';
  }
  return undefined;
}

describe('emptyRegistry', () => {
  it('always contains the master account and makes it active', () => {
    const state = emptyRegistry(NOW);
    expect(state.version).toBe(1);
    expect(state.activeAccountId).toBe(MASTER_ACCOUNT_ID);
    expect(state.accounts).toEqual([
      { id: MASTER_ACCOUNT_ID, kind: 'master', label: 'Master', createdAt: NOW },
    ]);
  });
});

describe('addAccount', () => {
  it('adds an extra account with a generated id and trimmed label', () => {
    const { state, account } = addAccount(emptyRegistry(NOW), { label: '  Work  ' }, deps);
    expect(account).toEqual({ id: 'acct_test0001', kind: 'extra', label: 'Work', createdAt: NOW });
    expect(state.accounts.map((a) => a.id)).toEqual([MASTER_ACCOUNT_ID, 'acct_test0001']);
    // Adding never changes which account is active.
    expect(state.activeAccountId).toBe(MASTER_ACCOUNT_ID);
  });

  it.each(['', '   ', 'x'.repeat(41), 'bad\u0007label'])('rejects invalid label %j', (label) => {
    expect(errorCode(() => addAccount(emptyRegistry(NOW), { label }, deps))).toBe('invalid_label');
  });

  it('rejects an identity that is already registered, case-insensitively', () => {
    let { state } = addAccount(emptyRegistry(NOW), { label: 'A', identity: { email: 'me@example.com' } }, deps);
    expect(
      errorCode(() => addAccount(state, { label: 'B', identity: { email: 'ME@Example.com' } }, deps)),
    ).toBe('duplicate_identity');
    state = updateIdentity(state, MASTER_ACCOUNT_ID, { email: 'boss@example.com' });
    expect(
      errorCode(() => addAccount(state, { label: 'C', identity: { email: 'boss@example.com' } }, deps)),
    ).toBe('duplicate_identity');
  });

  it('refuses a generated id that collides or is malformed', () => {
    const fixed = { now: () => NOW, newId: () => 'acct_same0001' };
    const { state } = addAccount(emptyRegistry(NOW), { label: 'A' }, fixed);
    expect(errorCode(() => addAccount(state, { label: 'B' }, fixed))).toBe('id_collision');
    expect(
      errorCode(() => addAccount(emptyRegistry(NOW), { label: 'A' }, { now: () => NOW, newId: () => '../evil' })),
    ).toBe('invalid_id');
  });
});

describe('removeAccount', () => {
  it('never removes the master', () => {
    expect(errorCode(() => removeAccount(emptyRegistry(NOW), MASTER_ACCOUNT_ID))).toBe('master_immutable');
  });

  it('rejects unknown ids', () => {
    expect(errorCode(() => removeAccount(emptyRegistry(NOW), 'acct_nope0001'))).toBe('unknown_account');
  });

  it('falls back to master when the active account is removed', () => {
    const added = addAccount(emptyRegistry(NOW), { label: 'Work' }, deps);
    const active = setActiveAccount(added.state, added.account.id);
    const removed = removeAccount(active, added.account.id);
    expect(removed.activeAccountId).toBe(MASTER_ACCOUNT_ID);
    expect(removed.accounts.map((a) => a.id)).toEqual([MASTER_ACCOUNT_ID]);
  });
});

describe('setActiveAccount / touchAccount / updateIdentity', () => {
  it('switches the active account and rejects unknown ids', () => {
    const { state, account } = addAccount(emptyRegistry(NOW), { label: 'Work' }, deps);
    expect(setActiveAccount(state, account.id).activeAccountId).toBe(account.id);
    expect(errorCode(() => setActiveAccount(state, 'acct_nope0001'))).toBe('unknown_account');
  });

  it('records last use without mutating the input', () => {
    const base = emptyRegistry(NOW);
    const touched = touchAccount(base, MASTER_ACCOUNT_ID, NOW + 5);
    expect(touched.accounts[0]?.lastUsedAt).toBe(NOW + 5);
    expect(base.accounts[0]?.lastUsedAt).toBeUndefined();
  });

  it('refuses an identity update that duplicates another account', () => {
    let { state, account } = addAccount(emptyRegistry(NOW), { label: 'Work', identity: { email: 'w@example.com' } }, deps);
    expect(errorCode(() => updateIdentity(state, MASTER_ACCOUNT_ID, { email: 'W@example.com' }))).toBe(
      'duplicate_identity',
    );
    // Updating an account with its own email is fine.
    state = updateIdentity(state, account.id, { email: 'w@example.com', subscriptionType: 'pro' });
    expect(state.accounts[1]?.identity).toEqual({ email: 'w@example.com', subscriptionType: 'pro' });
  });
});

describe('parseRegistry', () => {
  it('restores the master entry if it was removed by hand', () => {
    const parsed = parseRegistry(
      {
        version: 1,
        activeAccountId: 'acct_work0001',
        accounts: [{ id: 'acct_work0001', kind: 'extra', label: 'Work', createdAt: NOW }],
      },
      NOW,
    );
    expect(parsed.problem).toBeUndefined();
    expect(parsed.state.accounts.map((a) => a.id)).toEqual([MASTER_ACCOUNT_ID, 'acct_work0001']);
    expect(parsed.state.activeAccountId).toBe('acct_work0001');
  });

  it('drops malformed entries and repairs a dangling active id', () => {
    const parsed = parseRegistry(
      {
        version: 1,
        activeAccountId: 'acct_gone0001',
        accounts: [
          { id: MASTER_ACCOUNT_ID, kind: 'master', label: 'Master', createdAt: NOW },
          { id: '../../etc', kind: 'extra', label: 'Evil', createdAt: NOW },
          { id: 'acct_ok000001', kind: 'extra', label: '', createdAt: NOW },
          { id: 'acct_ok000002', kind: 'extra', label: 'Fine', createdAt: 'yesterday' },
        ],
      },
      NOW,
    );
    expect(parsed.state.accounts.map((a) => a.id)).toEqual([MASTER_ACCOUNT_ID]);
    expect(parsed.state.activeAccountId).toBe(MASTER_ACCOUNT_ID);
    expect(parsed.problem).toBe('repaired');
  });

  it.each([null, 'text', [], { version: 2, accounts: [] }])('treats %j as unusable', (raw) => {
    const parsed = parseRegistry(raw, NOW);
    expect(parsed.state).toEqual(emptyRegistry(NOW));
    expect(parsed.problem).toBe(
      raw && typeof raw === 'object' && !Array.isArray(raw) ? 'unsupported_version' : 'corrupt',
    );
  });
});

describe('createRegistryStore (real temp dir)', () => {
  let dir: string;
  const log = { warn: vi.fn() };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-acct-registry-'));
    log.warn.mockClear();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns master-only state when no file exists yet', async () => {
    const store = createRegistryStore({ filePath: path.join(dir, 'registry.json'), now: () => NOW, log });
    expect(await store.load()).toEqual(emptyRegistry(NOW));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('round-trips through an atomic write and leaves no temp files', async () => {
    const filePath = path.join(dir, 'nested', 'registry.json');
    const store = createRegistryStore({ filePath, now: () => NOW, log });
    const { state } = addAccount(emptyRegistry(NOW), { label: 'Work' }, deps);
    await store.save(state);
    expect(await store.load()).toEqual(state);
    expect(await readdir(path.dirname(filePath))).toEqual(['registry.json']);
  });

  it('keeps a corrupt file aside instead of overwriting it', async () => {
    const filePath = path.join(dir, 'registry.json');
    await writeFile(filePath, '{not json');
    const store = createRegistryStore({ filePath, now: () => NOW, log });
    expect(await store.load()).toEqual(emptyRegistry(NOW));
    const names = await readdir(dir);
    const backup = names.find((n) => n.startsWith('registry.json.corrupt-'));
    expect(backup).toBeDefined();
    expect(await readFile(path.join(dir, backup!), 'utf8')).toBe('{not json');
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('serialises concurrent saves so the last call wins', async () => {
    const filePath = path.join(dir, 'registry.json');
    const store = createRegistryStore({ filePath, now: () => NOW, log });
    const a = addAccount(emptyRegistry(NOW), { label: 'A' }, deps).state;
    const b = addAccount(a, { label: 'B' }, deps).state;
    await Promise.all([store.save(a), store.save(b)]);
    expect((await store.load()).accounts.map((x) => x.label)).toEqual(['Master', 'A', 'B']);
  });
});
