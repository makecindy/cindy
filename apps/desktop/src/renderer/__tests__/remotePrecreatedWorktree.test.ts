// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing,
  createRemoteSessionWithPrecreatedWorktree,
  isRemotePrecreatedWorktreeCleanupPendingError,
  isRemotePrecreatedWorktreeOwnerChangedError,
  listPendingRemotePrecreatedWorktrees,
  recoverPendingRemotePrecreatedWorktrees,
  registerPendingRemotePrecreatedWorktree,
} from '../features/cc-agent/remotePrecreatedWorktree';
import {
  normalizePendingRemotePrecreatedWorktrees,
  remotePrecreatedWorktreeRecordKey,
  type PendingRemotePrecreatedWorktree,
  type PendingRemotePrecreatedWorktreeTarget,
} from '../../shared/remotePrecreatedWorktreeLedger';

const DEVICE_ID = 'device-1';
const SESSION_ID = 'session-1';
const WORKTREE_PATH = '/repo/.cindy-worktrees/session-1';
const RECOVERY_KEY = 'recovery-key-123456';
const CREATE_ARGS = { id: SESSION_ID, workingDir: WORKTREE_PATH };
let ledgerRecords: PendingRemotePrecreatedWorktree[] = [];
let ledgerReadable = true;
let ledgerWritable = true;

function targetMatches(
  item: PendingRemotePrecreatedWorktree,
  target: PendingRemotePrecreatedWorktreeTarget,
): boolean {
  if (
    item.deviceId !== target.deviceId
    || item.sessionId !== target.sessionId
  ) return false;
  const locatorMatches = target.recoveryKey !== undefined
    ? item.recoveryKey === target.recoveryKey
    : target.path !== undefined && item.path === target.path;
  return locatorMatches
    && (target.createdAt === undefined || target.createdAt === item.createdAt);
}

function callWith(
  invoke: ReturnType<typeof vi.fn>,
  patch: Partial<Parameters<typeof createRemoteSessionWithPrecreatedWorktree>[0]> = {},
) {
  return createRemoteSessionWithPrecreatedWorktree({
    deviceId: DEVICE_ID,
    sessionId: SESSION_ID,
    path: WORKTREE_PATH,
    recoveryKey: RECOVERY_KEY,
    createArgs: CREATE_ARGS,
    invoke,
    ...patch,
  });
}

describe('createRemoteSessionWithPrecreatedWorktree', () => {
  beforeEach(() => {
    localStorage.clear();
    ledgerRecords = [];
    ledgerReadable = true;
    ledgerWritable = true;
    __testing.setLedgerApi({
      list: async () => ({
        records: ledgerRecords,
        storageReadable: ledgerReadable,
      }),
      register: async (record) => {
        ledgerRecords = normalizePendingRemotePrecreatedWorktrees([
          record,
          ...ledgerRecords.filter(
            (item) =>
              remotePrecreatedWorktreeRecordKey(item)
              !== remotePrecreatedWorktreeRecordKey(record),
          ),
        ]);
        return { persisted: ledgerReadable && ledgerWritable };
      },
      forget: async (target) => {
        if (!ledgerReadable || !ledgerWritable) return { persisted: false };
        ledgerRecords = ledgerRecords.filter((item) => !targetMatches(item, target));
        return { persisted: true };
      },
    });
  });

  it('returns immediately when create adopts the preset id', async () => {
    const invoke = vi.fn(async () => {
      await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([
        expect.objectContaining({
          deviceId: DEVICE_ID,
          sessionId: SESSION_ID,
          path: WORKTREE_PATH,
          recoveryKey: RECOVERY_KEY,
        }),
      ]);
      return { sessionId: SESSION_ID };
    });

    await expect(callWith(invoke)).resolves.toBe(SESSION_ID);
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([]);
  });

  it('stops after an owner switch without probing, discarding, or removing the old ledger', async () => {
    let currentOwner = 'owner-a';
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') {
        currentOwner = 'owner-b';
        return { sessionId: SESSION_ID };
      }
      throw new Error(`unexpected ${channel}`);
    });

    const failure = await callWith(invoke, {
      dataOwnerId: 'owner-a',
      isCurrent: () => currentOwner === 'owner-a',
    }).catch((error: unknown) => error);

    expect(isRemotePrecreatedWorktreeOwnerChangedError(failure)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ledgerRecords).toEqual([
      expect.objectContaining({
        dataOwnerId: 'owner-a',
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
      }),
    ]);
  });

  it('recovers a successful create whose response was lost', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw new Error('[DEVICE_LINK_TIMEOUT] timed out');
      if (channel === 'local-db:sessions:get') return { id: SESSION_ID };
      throw new Error(`unexpected ${channel}`);
    });

    await expect(callWith(invoke)).resolves.toBe(SESSION_ID);
    expect(invoke).not.toHaveBeenCalledWith('worktree:discard-precreated', expect.anything());
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([]);
  });

  it('discards the exact pre-created path after a confirmed create failure', async () => {
    const createError = new Error('[INVALID_PARAMS] bad create');
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw createError;
      if (channel === 'local-db:sessions:get') throw new Error('[NOT_FOUND] Session 不存在');
      if (channel === 'worktree:discard-precreated') return { discarded: true };
      throw new Error(`unexpected ${channel}`);
    });

    await expect(callWith(invoke)).rejects.toBe(createError);
    expect(invoke).toHaveBeenCalledWith('worktree:discard-precreated', [{
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
    }]);
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([]);
  });

  it('re-probes when discard loses the race to a successful create', async () => {
    let probes = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw new Error('[DEVICE_LINK_TIMEOUT] timed out');
      if (channel === 'local-db:sessions:get') {
        probes += 1;
        if (probes === 1) throw new Error('[NOT_FOUND] Session 不存在');
        return { id: SESSION_ID };
      }
      if (channel === 'worktree:discard-precreated') {
        throw new Error('[PRECONDITION_FAILED] 会话已认领该 worktree');
      }
      throw new Error(`unexpected ${channel}`);
    });

    await expect(callWith(invoke)).resolves.toBe(SESSION_ID);
    expect(probes).toBe(2);
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([]);
  });

  it('retains the cleanup obligation when discard and ownership probes cannot settle it', async () => {
    const createError = new Error('[INVALID_PARAMS] bad create');
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw createError;
      if (channel === 'local-db:sessions:get') throw new Error('[NOT_FOUND] Session 不存在');
      if (channel === 'worktree:discard-precreated') {
        throw new Error('[PRECONDITION_FAILED] worktree 已有改动');
      }
      throw new Error(`unexpected ${channel}`);
    });

    const failure = await callWith(invoke).catch((error: unknown) => error);
    expect(isRemotePrecreatedWorktreeCleanupPendingError(failure)).toBe(true);
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([
      expect.objectContaining({
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
      }),
    ]);
  });

  it('keeps the cleanup obligation fail-closed when the old desktop has no discard channel', async () => {
    const createError = new Error('[INVALID_PARAMS] bad create');
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw createError;
      if (channel === 'local-db:sessions:get') {
        throw new Error('[NOT_FOUND] Session 不存在');
      }
      if (channel === 'worktree:discard-precreated') {
        throw new Error('[CHANNEL_NOT_ALLOWED] unsupported');
      }
      throw new Error(`unexpected ${channel}`);
    });

    const failure = await callWith(invoke).catch((error: unknown) => error);
    expect(isRemotePrecreatedWorktreeCleanupPendingError(failure)).toBe(true);
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([
      expect.objectContaining({
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
      }),
    ]);
  });

  it('recovers a retained obligation before another worktree is created', async () => {
    await registerPendingRemotePrecreatedWorktree({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
      createdAt: Date.now(),
    });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'local-db:sessions:get') {
        throw new Error('[NOT_FOUND] Session 不存在');
      }
      if (channel === 'worktree:discard-precreated') return { discarded: true };
      throw new Error(`unexpected ${channel}`);
    });

    await expect(
      recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        invoke,
      }),
    ).resolves.toEqual({
      attempted: 1,
      recovered: 1,
      retained: 0,
      storageReadable: true,
    });
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([]);
  });

  it('recovers a pre-response reservation by recovery key after restart', async () => {
    await registerPendingRemotePrecreatedWorktree({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      recoveryKey: RECOVERY_KEY,
      createdAt: Date.now(),
    });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'local-db:sessions:get') {
        throw new Error('[NOT_FOUND] Session 不存在');
      }
      if (channel === 'worktree:discard-precreated') return { discarded: true };
      throw new Error(`unexpected ${channel}`);
    });

    await expect(
      recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        invoke,
      }),
    ).resolves.toMatchObject({
      attempted: 1,
      recovered: 1,
      retained: 0,
      storageReadable: true,
    });
    expect(invoke).toHaveBeenCalledWith('worktree:discard-precreated', [{
      sessionId: SESSION_ID,
      recoveryKey: RECOVERY_KEY,
    }]);
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([]);
  });

  it('keeps the obligation when next-send recovery is still offline', async () => {
    await registerPendingRemotePrecreatedWorktree({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
      createdAt: Date.now(),
    });
    const invoke = vi.fn(async () => {
      throw new Error('[DEVICE_LINK_TIMEOUT] timed out');
    });

    await expect(
      recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        invoke,
      }),
    ).resolves.toEqual({
      attempted: 1,
      recovered: 0,
      retained: 1,
      storageReadable: true,
    });
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toHaveLength(1);
  });

  it('keeps the obligation when next-send recovery reaches an old desktop', async () => {
    await registerPendingRemotePrecreatedWorktree({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
      createdAt: Date.now(),
    });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'local-db:sessions:get') {
        throw new Error('[NOT_FOUND] Session 不存在');
      }
      if (channel === 'worktree:discard-precreated') {
        throw new Error('[CHANNEL_NOT_ALLOWED] unsupported');
      }
      throw new Error(`unexpected ${channel}`);
    });

    await expect(
      recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        invoke,
      }),
    ).resolves.toEqual({
      attempted: 1,
      recovered: 0,
      retained: 1,
      storageReadable: true,
    });
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toHaveLength(1);
  });

  it('does not recover another owner’s obligation after an account switch', async () => {
    ledgerRecords = [{
      dataOwnerId: 'owner-a',
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
      createdAt: Date.now(),
    }];
    const invoke = vi.fn();

    await expect(
      recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        dataOwnerId: 'owner-b',
        invoke,
      }),
    ).resolves.toEqual({
      attempted: 0,
      recovered: 0,
      retained: 0,
      storageReadable: true,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(ledgerRecords).toHaveLength(1);
  });

  it('stops in-flight recovery after an owner switch and preserves the old ledger', async () => {
    ledgerRecords = [{
      dataOwnerId: 'owner-a',
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
      createdAt: Date.now(),
    }];
    let currentOwner = 'owner-a';
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'local-db:sessions:get') {
        currentOwner = 'owner-b';
        throw new Error('[NOT_FOUND] Session 不存在');
      }
      throw new Error(`unexpected ${channel}`);
    });

    const failure = await recoverPendingRemotePrecreatedWorktrees({
      deviceId: DEVICE_ID,
      dataOwnerId: 'owner-a',
      invoke,
      isCurrent: () => currentOwner === 'owner-a',
    }).catch((error: unknown) => error);

    expect(isRemotePrecreatedWorktreeOwnerChangedError(failure)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ledgerRecords).toHaveLength(1);
  });

  it('migrates a path-only legacy record under an explicit owner binding', async () => {
    localStorage.setItem(__testing.storageKey, JSON.stringify({
      version: 1,
      records: [{
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
        createdAt: Date.now(),
      }],
    }));

    await expect(
      registerPendingRemotePrecreatedWorktree({
        dataOwnerId: 'owner-b',
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
        createdAt: Date.now(),
      }),
    ).resolves.toBe(true);
    expect(localStorage.getItem(__testing.storageKey)).toBeNull();
    expect(localStorage.getItem(__testing.storageOwnerKey)).toBeNull();
    expect(ledgerRecords).toEqual([
      expect.objectContaining({ dataOwnerId: 'owner-b' }),
    ]);
  });

  it('does not let another owner claim a legacy key already bound to the first owner', async () => {
    localStorage.setItem(__testing.storageKey, JSON.stringify({
      version: 1,
      records: [{
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
        createdAt: Date.now(),
      }],
    }));
    localStorage.setItem(__testing.storageOwnerKey, 'owner-a');

    await expect(
      registerPendingRemotePrecreatedWorktree({
        dataOwnerId: 'owner-b',
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
        createdAt: Date.now(),
      }),
    ).resolves.toBe(false);
    expect(localStorage.getItem(__testing.storageKey)).not.toBeNull();
    expect(localStorage.getItem(__testing.storageOwnerKey)).toBe('owner-a');
    expect(ledgerRecords).toEqual([]);
  });

  it('uses the Main memory mirror when its persistent write fails', async () => {
    ledgerWritable = false;
    await expect(
      registerPendingRemotePrecreatedWorktree({
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
        createdAt: Date.now(),
      }),
    ).resolves.toBe(false);
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toHaveLength(1);
    ledgerWritable = true;

    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'local-db:sessions:get') return { id: SESSION_ID };
      throw new Error(`unexpected ${channel}`);
    });
    await expect(
      recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        invoke,
      }),
    ).resolves.toMatchObject({ recovered: 1, retained: 0 });
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([]);
  });

  it('does not overwrite an unknown legacy ledger when localStorage reads fail', async () => {
    localStorage.setItem(__testing.storageKey, JSON.stringify({
      version: 1,
      records: [{
        dataOwnerId: 'owner-a',
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
        createdAt: Date.now(),
      }],
    }));
    const persisted = localStorage.getItem(__testing.storageKey);

    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
      () => {
        throw new Error('read unavailable');
      },
    );
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();

    getItem.mockRestore();
    setItem.mockRestore();
    removeItem.mockRestore();
    expect(localStorage.getItem(__testing.storageKey)).toBe(persisted);
    await expect(listPendingRemotePrecreatedWorktrees('owner-a')).resolves.toHaveLength(1);
    expect(localStorage.getItem(__testing.storageKey)).toBeNull();
  });

  it('fails closed before recovery when the persisted ledger cannot be read', async () => {
    localStorage.setItem(__testing.storageKey, JSON.stringify({
      version: 1,
      records: [{
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
        createdAt: Date.now(),
      }],
    }));
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
      () => {
        throw new Error('read unavailable');
      },
    );
    const invoke = vi.fn();

    await expect(
      recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        invoke,
      }),
    ).resolves.toEqual({
      attempted: 0,
      recovered: 0,
      retained: 0,
      storageReadable: false,
    });
    expect(invoke).not.toHaveBeenCalled();
    getItem.mockRestore();
  });

  it('preserves malformed persisted JSON and fails closed before another worktree', async () => {
    localStorage.setItem(__testing.storageKey, '{{{');
    const invoke = vi.fn();

    await expect(
      recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        invoke,
      }),
    ).resolves.toEqual({
      attempted: 0,
      recovered: 0,
      retained: 0,
      storageReadable: false,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem(__testing.storageKey)).toBe('{{{');

    await expect(
      registerPendingRemotePrecreatedWorktree({
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
        createdAt: Date.now(),
      }),
    ).resolves.toBe(false);
    expect(localStorage.getItem(__testing.storageKey)).toBe('{{{');
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([]);
  });
});
