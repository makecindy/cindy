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
  records: PendingRemotePrecreatedWorktree[] = [];
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
};
const second: PendingRemotePrecreatedWorktree = {
  dataOwnerId: 'owner-a',
  deviceId: 'device-2',
  sessionId: 'session-2',
  recoveryKey: 'recovery-key-222222',
  createdAt: createdAt + 1,
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
      },
    ];

    expect(listRemotePrecreatedWorktreeLedger()).toEqual({
      records: [first],
      storageReadable: false,
    });
    expect(store.records).toHaveLength(2);
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
