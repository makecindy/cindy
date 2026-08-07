import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const activeOwner = { id: 'owner-a' };

vi.mock('../appSessionState.js', () => ({
  getActiveAppSession: () => ({
    mode: 'cloud',
    dataOwnerId: activeOwner.id,
    generation: 1,
  }),
  ownerScopedUserDataPath: (...parts: string[]) =>
    `/tmp/cindy-owner-${activeOwner.id}/${parts.join('/')}`,
}));

import {
  __testing,
  forgetRemotePrecreatedWorktreeLedgerRecord,
  listRemotePrecreatedWorktreeLedger,
  registerRemotePrecreatedWorktreeLedgerRecord,
} from '../remotePrecreatedWorktreeLedger';
import type { PendingRemotePrecreatedWorktree } from '../../shared/remotePrecreatedWorktreeLedger';

class FakeLedgerStore {
  records: unknown = [];
  failRead = false;
  failWrite = false;

  get(): unknown {
    if (this.failRead) throw new Error('read failed');
    return this.records;
  }

  set(_key: 'records', value: PendingRemotePrecreatedWorktree[]): void {
    if (this.failWrite) throw new Error('write failed');
    this.records = structuredClone(value);
  }
}

const createdAt = Date.now();
const first: PendingRemotePrecreatedWorktree = {
  dataOwnerId: 'owner-a',
  deviceId: 'device-1',
  sessionId: 'session-1',
  recoveryKey: 'recovery-key-111111',
  createdAt,
  phase: 'reserved',
};
const second: PendingRemotePrecreatedWorktree = {
  dataOwnerId: 'owner-a',
  deviceId: 'device-2',
  sessionId: 'session-2',
  recoveryKey: 'recovery-key-222222',
  createdAt: createdAt + 1,
  phase: 'reserved',
};

describe('remotePrecreatedWorktreeLedger Main store', () => {
  let store: FakeLedgerStore;

  beforeEach(() => {
    activeOwner.id = 'owner-a';
    store = new FakeLedgerStore();
    __testing.setStore(store);
    __testing.resetMemory();
  });

  afterEach(() => {
    __testing.setStore(null);
    __testing.resetMemory();
  });

  it('serializes registrations from separate renderer calls without losing either record', async () => {
    const results = await Promise.all([
      Promise.resolve().then(() =>
        registerRemotePrecreatedWorktreeLedgerRecord(first)),
      Promise.resolve().then(() =>
        registerRemotePrecreatedWorktreeLedgerRecord(second)),
    ]);

    expect(results).toEqual([true, true]);
    expect(listRemotePrecreatedWorktreeLedger()).toMatchObject({
      storageReadable: true,
      records: [second, first],
    });
    expect(store.records).toEqual([second, first]);
  });

  it('retains a registration in Main memory when the persistent write fails', () => {
    store.failWrite = true;

    expect(registerRemotePrecreatedWorktreeLedgerRecord(first)).toBe(false);
    expect(listRemotePrecreatedWorktreeLedger()).toMatchObject({
      storageReadable: true,
      records: [first],
    });
  });

  it('never lets an equal-time persisted phase downgrade a retain-only memory phase', () => {
    const precreated: PendingRemotePrecreatedWorktree = {
      ...first,
      path: '/repo/.cindy-worktrees/session-1',
      phase: 'precreated',
    };
    expect(registerRemotePrecreatedWorktreeLedgerRecord(precreated)).toBe(true);
    store.failWrite = true;

    const started: PendingRemotePrecreatedWorktree = {
      ...precreated,
      phase: 'session-create-started',
    };
    expect(registerRemotePrecreatedWorktreeLedgerRecord(started)).toBe(false);
    expect(listRemotePrecreatedWorktreeLedger()).toEqual({
      records: [started],
      storageReadable: true,
    });
    expect(store.records).toEqual([precreated]);
  });

  it('does not forget an obligation when deletion cannot be persisted', () => {
    expect(registerRemotePrecreatedWorktreeLedgerRecord(first)).toBe(true);
    store.failWrite = true;

    expect(forgetRemotePrecreatedWorktreeLedgerRecord(first)).toBe(false);
    expect(listRemotePrecreatedWorktreeLedger().records).toEqual([first]);
  });

  it('fails closed on an unreadable persistent ledger while retaining new memory records', () => {
    store.failRead = true;

    expect(registerRemotePrecreatedWorktreeLedgerRecord(first)).toBe(false);
    expect(listRemotePrecreatedWorktreeLedger()).toEqual({
      records: [first],
      storageReadable: false,
    });
  });

  it('rejects a record from another owner before any persistent write', () => {
    activeOwner.id = 'owner-b';

    expect(registerRemotePrecreatedWorktreeLedgerRecord(first)).toBe(false);
    expect(store.records).toEqual([]);
    expect(listRemotePrecreatedWorktreeLedger()).toEqual({
      records: [],
      storageReadable: true,
    });
  });

  it('quarantines foreign or legacy records instead of exposing them to the active owner', () => {
    store.records = [
      first,
      {
        deviceId: 'device-legacy',
        sessionId: 'session-legacy',
        path: '/repo/legacy',
        createdAt,
        phase: 'session-create-started',
      },
    ];

    expect(listRemotePrecreatedWorktreeLedger()).toEqual({
      records: [first],
      storageReadable: false,
    });
    expect(store.records).toHaveLength(2);
  });

  it.each([
    [{ ...first, phase: 'future-phase' }],
    [{ ...first, recoveryKey: 'short' }],
    [first, { ...first, phase: 'session-create-started' }],
    Array.from({ length: 33 }, (_, index) => ({
      ...first,
      deviceId: `device-${index}`,
      sessionId: `session-${index}`,
      recoveryKey: `recovery-key-${String(index).padStart(16, '0')}`,
    })),
    { version: 2, records: [first] },
  ])('preserves malformed persisted storage and fails closed: %j', (malformed) => {
    store.records = structuredClone(malformed);

    expect(listRemotePrecreatedWorktreeLedger()).toEqual({
      records: [],
      storageReadable: false,
    });
    expect(store.records).toEqual(malformed);
    expect(registerRemotePrecreatedWorktreeLedgerRecord(first)).toBe(false);
    expect(store.records).toEqual(malformed);
  });

  it('normalizes a well-formed legacy record without phase to retain-only', () => {
    const legacy = {
      dataOwnerId: 'owner-a',
      deviceId: 'device-legacy',
      sessionId: 'session-legacy',
      recoveryKey: 'legacy-recovery-key-123456',
      createdAt,
    };
    store.records = [legacy];

    expect(listRemotePrecreatedWorktreeLedger()).toEqual({
      records: [{ ...legacy, phase: 'session-create-started' }],
      storageReadable: true,
    });
    expect(store.records).toEqual([
      { ...legacy, phase: 'session-create-started' },
    ]);
  });

  it('does not reuse an in-memory obligation after switching owners', () => {
    store.failWrite = true;
    expect(registerRemotePrecreatedWorktreeLedgerRecord(first)).toBe(false);

    activeOwner.id = 'owner-b';
    expect(listRemotePrecreatedWorktreeLedger()).toEqual({
      records: [],
      storageReadable: true,
    });

    activeOwner.id = 'owner-a';
    expect(listRemotePrecreatedWorktreeLedger()).toMatchObject({
      records: [first],
      storageReadable: true,
    });
  });
});
