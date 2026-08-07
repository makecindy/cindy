// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing,
  createRemoteSessionWithPrecreatedWorktree,
  isRemotePrecreatedWorktreeCleanupPendingError,
  isRemotePrecreatedWorktreeOwnerChangedError,
  listPendingRemotePrecreatedWorktrees,
  parseRemoteDiscardPrecreatedAck,
  parseRemoteWorktreeCreateResult,
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

describe('remote precreated worktree response parsers', () => {
  const request = {
    sessionId: SESSION_ID,
    baseRepo: '/repo',
    name: 'quiet-otter',
    sourceBranch: 'feature/source',
    recoveryKey: RECOVERY_KEY,
  };
  const meta = {
    sessionId: SESSION_ID,
    name: 'quiet-otter',
    path: WORKTREE_PATH,
    baseRepo: '/repo',
    branch: 'cindy/quiet-otter',
    sourceBranch: 'feature/source',
    createdAt: '2026-08-05T00:00:00.000Z',
    recoveryKey: RECOVERY_KEY,
  };

  it('accepts only a complete unambiguous create result', () => {
    expect(parseRemoteWorktreeCreateResult({ ok: true, meta }, request)).toEqual({
      ok: true,
      meta,
    });
    expect(parseRemoteWorktreeCreateResult({
      ok: false,
      error: { kind: 'unknown', message: 'failed' },
    }, request)).toEqual({
      ok: false,
      error: { kind: 'unknown', message: 'failed' },
    });

    for (const value of [
      null,
      {},
      { ok: true },
      { ok: false },
      { ok: true, meta, error: { kind: 'unknown', message: 'also failed' } },
      { ok: false, meta, error: { kind: 'unknown', message: 'failed' } },
    ]) {
      expect(parseRemoteWorktreeCreateResult(value, request)).toBeNull();
    }
  });

  it.each([
    ['sessionId', 'wrong-session'],
    ['baseRepo', '/wrong-repo'],
    ['sourceBranch', 'wrong-branch'],
    ['recoveryKey', 'wrong-recovery-key-123456'],
  ] as const)('rejects a create result with the wrong %s', (field, value) => {
    expect(parseRemoteWorktreeCreateResult({
      ok: true,
      meta: { ...meta, [field]: value },
    }, request)).toBeNull();
  });

  it('rejects a create result without its recovery key', () => {
    const { recoveryKey: _recoveryKey, ...withoutRecoveryKey } = meta;
    expect(parseRemoteWorktreeCreateResult({
      ok: true,
      meta: withoutRecoveryKey,
    }, request)).toBeNull();
  });

  it('accepts only the strict discard acknowledgement shape', () => {
    expect(parseRemoteDiscardPrecreatedAck({ discarded: true })).toEqual({
      discarded: true,
    });
    expect(parseRemoteDiscardPrecreatedAck({
      discarded: true,
      branchDeleted: false,
    })).toEqual({ discarded: true, branchDeleted: false });
    for (const value of [
      null,
      {},
      { discarded: false },
      { discarded: true, branchDeleted: 'yes' },
      { discarded: true, error: { code: 'FAILED' } },
      { discarded: true, ok: false },
    ]) {
      expect(parseRemoteDiscardPrecreatedAck(value)).toBeNull();
    }
  });
});

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

  it('retains the obligation after createSession starts even when the error looks deterministic', async () => {
    const createError = new Error('[INVALID_PARAMS] bad create');
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw createError;
      if (channel === 'local-db:sessions:get') throw new Error('[NOT_FOUND] Session 不存在');
      if (channel === 'worktree:discard-precreated') return { discarded: true };
      throw new Error(`unexpected ${channel}`);
    });

    const failure = await callWith(invoke).catch((error: unknown) => error);
    expect(isRemotePrecreatedWorktreeCleanupPendingError(failure)).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('worktree:discard-precreated', expect.anything());
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        phase: 'session-create-started',
      }),
    ]);
  });

  it('does not discard or probe twice after an exact NOT_FOUND once createSession started', async () => {
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

    const failure = await callWith(invoke).catch((error: unknown) => error);
    expect(isRemotePrecreatedWorktreeCleanupPendingError(failure)).toBe(true);
    expect(probes).toBe(1);
    expect(invoke).not.toHaveBeenCalledWith('worktree:discard-precreated', expect.anything());
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([
      expect.objectContaining({ phase: 'session-create-started' }),
    ]);
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
      phase: 'precreated',
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
      phase: 'reserved',
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

  it('prefers the recovery key when a record also has a legacy path', async () => {
    await registerPendingRemotePrecreatedWorktree({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
      recoveryKey: RECOVERY_KEY,
      createdAt: Date.now(),
      phase: 'precreated',
    });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'local-db:sessions:get') {
        throw new Error('[NOT_FOUND] Session 不存在');
      }
      if (channel === 'worktree:discard-precreated') return { discarded: true };
      throw new Error(`unexpected ${channel}`);
    });

    await expect(recoverPendingRemotePrecreatedWorktrees({
      deviceId: DEVICE_ID,
      invoke,
    })).resolves.toMatchObject({ recovered: 1, retained: 0 });
    expect(invoke).toHaveBeenCalledWith('worktree:discard-precreated', [{
      sessionId: SESSION_ID,
      recoveryKey: RECOVERY_KEY,
    }]);
  });

  it.each([null, {}, { id: 'wrong-session' }])(
    'retains without discard when ownership returns %j',
    async (ownershipResult) => {
      await registerPendingRemotePrecreatedWorktree({
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        recoveryKey: RECOVERY_KEY,
        createdAt: Date.now(),
        phase: 'reserved',
      });
      const invoke = vi.fn(async (channel: string) => {
        if (channel === 'local-db:sessions:get') return ownershipResult;
        if (channel === 'worktree:discard-precreated') return { discarded: true };
        throw new Error(`unexpected ${channel}`);
      });

      await expect(recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        invoke,
      })).resolves.toMatchObject({ recovered: 0, retained: 1 });
      expect(invoke).not.toHaveBeenCalledWith(
        'worktree:discard-precreated',
        expect.anything(),
      );
    },
  );

  it('does not treat incidental nested NOT_FOUND text as proof of absence', async () => {
    await registerPendingRemotePrecreatedWorktree({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      recoveryKey: RECOVERY_KEY,
      createdAt: Date.now(),
      phase: 'reserved',
    });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'local-db:sessions:get') {
        throw new Error('transport failed: Error: [NOT_FOUND] incidental text');
      }
      if (channel === 'worktree:discard-precreated') return { discarded: true };
      throw new Error(`unexpected ${channel}`);
    });

    await expect(recoverPendingRemotePrecreatedWorktrees({
      deviceId: DEVICE_ID,
      invoke,
    })).resolves.toMatchObject({ recovered: 0, retained: 1 });
    expect(invoke).not.toHaveBeenCalledWith(
      'worktree:discard-precreated',
      expect.anything(),
    );
  });

  it.each([
    null,
    {},
    { discarded: false },
    { discarded: true, error: { code: 'FAILED' } },
  ])('retains when discard returns malformed acknowledgement %j', async (ack) => {
    await registerPendingRemotePrecreatedWorktree({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      recoveryKey: RECOVERY_KEY,
      createdAt: Date.now(),
      phase: 'precreated',
    });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'local-db:sessions:get') {
        throw new Error('[NOT_FOUND] Session 不存在');
      }
      if (channel === 'worktree:discard-precreated') return ack;
      throw new Error(`unexpected ${channel}`);
    });

    await expect(recoverPendingRemotePrecreatedWorktrees({
      deviceId: DEVICE_ID,
      invoke,
    })).resolves.toMatchObject({ recovered: 0, retained: 1 });
  });

  it.each([
    { phase: 'session-create-started' as const },
    {},
  ])('never discards a started or legacy phase record %#', async (phasePatch) => {
    ledgerRecords = [{
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      recoveryKey: RECOVERY_KEY,
      createdAt: Date.now(),
      ...phasePatch,
    } as PendingRemotePrecreatedWorktree];
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'local-db:sessions:get') {
        throw new Error('[NOT_FOUND] Session 不存在');
      }
      if (channel === 'worktree:discard-precreated') return { discarded: true };
      throw new Error(`unexpected ${channel}`);
    });

    await expect(recoverPendingRemotePrecreatedWorktrees({
      deviceId: DEVICE_ID,
      invoke,
    })).resolves.toMatchObject({ recovered: 0, retained: 1 });
    expect(invoke).not.toHaveBeenCalledWith(
      'worktree:discard-precreated',
      expect.anything(),
    );
  });

  it('keeps the obligation when next-send recovery is still offline', async () => {
    await registerPendingRemotePrecreatedWorktree({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
      createdAt: Date.now(),
      phase: 'precreated',
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
      phase: 'precreated',
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
      phase: 'precreated',
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
      phase: 'precreated',
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
        phase: 'precreated',
      }],
    }));

    await expect(
      registerPendingRemotePrecreatedWorktree({
        dataOwnerId: 'owner-b',
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
        createdAt: Date.now(),
        phase: 'precreated',
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
        phase: 'precreated',
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
        phase: 'precreated',
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
        phase: 'precreated',
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

  it.each([
    { version: 2, records: [] },
    {
      version: 1,
      records: [{
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
        createdAt: Date.now(),
        phase: 'future-phase',
      }],
    },
    {
      version: 1,
      records: [
        {
          deviceId: DEVICE_ID,
          sessionId: SESSION_ID,
          path: WORKTREE_PATH,
          createdAt: Date.now(),
          phase: 'session-create-started',
        },
        {
          deviceId: DEVICE_ID,
          sessionId: SESSION_ID,
          path: WORKTREE_PATH,
          createdAt: Date.now(),
          phase: 'precreated',
        },
      ],
    },
    {
      version: 1,
      records: Array.from({ length: 33 }, (_, index) => ({
        deviceId: `device-${index}`,
        sessionId: `session-${index}`,
        path: `/repo/.cindy-worktrees/${index}`,
        createdAt: Date.now(),
        phase: 'precreated',
      })),
    },
  ])('preserves an unknown or malformed legacy ledger: %j', async (payload) => {
    const raw = JSON.stringify(payload);
    localStorage.setItem(__testing.storageKey, raw);
    const invoke = vi.fn();

    await expect(recoverPendingRemotePrecreatedWorktrees({
      deviceId: DEVICE_ID,
      invoke,
    })).resolves.toMatchObject({
      attempted: 0,
      storageReadable: false,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem(__testing.storageKey)).toBe(raw);
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
        phase: 'precreated',
      }),
    ).resolves.toBe(false);
    expect(localStorage.getItem(__testing.storageKey)).toBe('{{{');
    await expect(listPendingRemotePrecreatedWorktrees()).resolves.toEqual([]);
  });
});
