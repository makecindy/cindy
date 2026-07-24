import { describe, expect, it } from 'vitest';
import {
  acquireQueueEditLock,
  commitQueueEdit,
  releaseQueueEditLock,
  releaseQueueEditLockAfter,
} from '@/session/queueEditLifecycle';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('queueEditLifecycle', () => {
  it('waits for the remote edit lock before updating and releasing it', async () => {
    const lockReady = deferred();
    const calls: string[] = [];
    const owner = acquireQueueEditLock(null, 'q-1', async (_clientId, locked) => {
      calls.push(locked ? 'lock' : 'unlock');
      if (locked) await lockReady.promise;
    });

    const committed = commitQueueEdit(owner, () => {
      calls.push('update');
      return true;
    });
    await Promise.resolve();
    expect(calls).toEqual(['lock']);

    lockReady.resolve();
    await committed;
    expect(calls).toEqual(['lock', 'update', 'unlock']);
  });

  it('supports editing the same queued message twice without retaining the first lock', async () => {
    const calls: string[] = [];
    const setLock = (clientId: string, locked: boolean) => {
      calls.push(`${clientId}:${locked ? 'lock' : 'unlock'}`);
    };

    const first = acquireQueueEditLock(null, 'q-1', setLock);
    await commitQueueEdit(first, () => {
      calls.push('first:update');
      return true;
    });
    const second = acquireQueueEditLock(null, 'q-1', setLock);
    await commitQueueEdit(second, () => {
      calls.push('second:update');
      return true;
    });

    expect(calls).toEqual([
      'q-1:lock',
      'first:update',
      'q-1:unlock',
      'q-1:lock',
      'second:update',
      'q-1:unlock',
    ]);
  });

  it('waits for a pending lock request before a fast cancel releases it', async () => {
    const lockReady = deferred();
    const calls: string[] = [];
    const owner = acquireQueueEditLock(null, 'q-1', async (_clientId, locked) => {
      calls.push(locked ? 'lock' : 'unlock');
      if (locked) await lockReady.promise;
    });

    const released = releaseQueueEditLock(owner);
    await Promise.resolve();
    expect(calls).toEqual(['lock']);

    lockReady.resolve();
    await released;
    expect(calls).toEqual(['lock', 'unlock']);
  });

  it('does not update when the remote lock request fails', async () => {
    const lockError = new Error('lock failed');
    const calls: string[] = [];
    const owner = acquireQueueEditLock(null, 'q-1', async (_clientId, locked) => {
      calls.push(locked ? 'lock' : 'unlock');
      if (locked) throw lockError;
    });

    await expect(commitQueueEdit(owner, () => {
      calls.push('update');
      return true;
    })).rejects.toBe(lockError);
    expect(calls).toEqual(['lock']);

    await expect(releaseQueueEditLock(owner)).resolves.toBeUndefined();
    expect(calls).toEqual(['lock', 'unlock']);
  });

  it('rejects the save when releasing the remote lock fails', async () => {
    const unlockError = new Error('unlock failed');
    const calls: string[] = [];
    const owner = acquireQueueEditLock(null, 'q-1', async (_clientId, locked) => {
      calls.push(locked ? 'lock' : 'unlock');
      if (!locked) throw unlockError;
    });

    await expect(commitQueueEdit(owner, () => {
      calls.push('update');
      return true;
    })).rejects.toBe(unlockError);
    expect(calls).toEqual(['lock', 'update', 'unlock']);
  });

  it('keeps the lock when the queued message update fails', async () => {
    const updateError = new Error('update failed');
    const calls: string[] = [];
    const owner = acquireQueueEditLock(null, 'q-1', (_clientId, locked) => {
      calls.push(locked ? 'lock' : 'unlock');
    });

    await expect(commitQueueEdit(owner, () => {
      calls.push('update');
      throw updateError;
    })).rejects.toBe(updateError);
    expect(calls).toEqual(['lock', 'update']);

    await releaseQueueEditLock(owner);
    expect(calls).toEqual(['lock', 'update', 'unlock']);
  });

  it('keeps the lock when the queued message update is declined', async () => {
    const calls: string[] = [];
    const owner = acquireQueueEditLock(null, 'q-1', (_clientId, locked) => {
      calls.push(locked ? 'lock' : 'unlock');
    });

    await expect(commitQueueEdit(owner, () => {
      calls.push('update');
      return false;
    })).resolves.toBe(false);
    expect(calls).toEqual(['lock', 'update']);

    await releaseQueueEditLock(owner);
    expect(calls).toEqual(['lock', 'update', 'unlock']);
  });

  it('continues switching messages after a failed lock is compensated', async () => {
    const calls: string[] = [];
    const setLock = async (clientId: string, locked: boolean) => {
      calls.push(`${clientId}:${locked ? 'lock' : 'unlock'}`);
      if (clientId === 'q-1' && locked) throw new Error('lock failed');
    };
    const first = acquireQueueEditLock(null, 'q-1', setLock);
    const second = acquireQueueEditLock(first, 'q-2', setLock);

    await expect(second.ready).resolves.toBeUndefined();
    expect(calls).toEqual(['q-1:lock', 'q-1:unlock', 'q-2:lock']);
  });

  it('releases a failed save after cancel waits for it to settle', async () => {
    let rejectUpdate!: (error: Error) => void;
    const update = new Promise<boolean>((_resolve, reject) => {
      rejectUpdate = reject;
    });
    const updateStarted = deferred();
    const calls: string[] = [];
    const owner = acquireQueueEditLock(null, 'q-1', (_clientId, locked) => {
      calls.push(locked ? 'lock' : 'unlock');
    });
    const save = commitQueueEdit(owner, () => {
      calls.push('update');
      updateStarted.resolve();
      return update;
    });
    const release = releaseQueueEditLockAfter(owner, save);

    await updateStarted.promise;
    expect(calls).toEqual(['lock', 'update']);

    const updateError = new Error('update failed');
    rejectUpdate(updateError);
    await expect(save).rejects.toBe(updateError);
    await expect(release).resolves.toBeUndefined();
    expect(calls).toEqual(['lock', 'update', 'unlock']);
  });

  it('coalesces save and cleanup unlocks after a successful update', async () => {
    const calls: string[] = [];
    const owner = acquireQueueEditLock(null, 'q-1', (_clientId, locked) => {
      calls.push(locked ? 'lock' : 'unlock');
    });
    const save = commitQueueEdit(owner, () => {
      calls.push('update');
      return true;
    });

    await Promise.all([
      save,
      releaseQueueEditLockAfter(owner, save),
    ]);
    expect(calls).toEqual(['lock', 'update', 'unlock']);
  });

  it('continues acquiring a new lock after the previous unlock fails', async () => {
    const calls: string[] = [];
    const setLock = async (clientId: string, locked: boolean) => {
      calls.push(`${clientId}:${locked ? 'lock' : 'unlock'}`);
      if (clientId === 'q-1' && !locked) throw new Error('unlock failed');
    };
    const first = acquireQueueEditLock(null, 'q-1', setLock);
    await first.ready;
    const second = acquireQueueEditLock(first, 'q-2', setLock);

    await expect(second.ready).resolves.toBeUndefined();
    expect(calls).toEqual(['q-1:lock', 'q-1:unlock', 'q-2:lock']);
  });

  it('retries an unlock that failed while the save was finishing', async () => {
    let unlockAttempts = 0;
    const calls: string[] = [];
    const owner = acquireQueueEditLock(null, 'q-1', (_clientId, locked) => {
      calls.push(locked ? 'lock' : 'unlock');
      if (!locked && unlockAttempts++ === 0) throw new Error('unlock failed');
    });
    const save = commitQueueEdit(owner, () => {
      calls.push('update');
      return true;
    });

    await expect(releaseQueueEditLockAfter(owner, save)).resolves.toBeUndefined();
    await expect(save).rejects.toThrow('unlock failed');
    expect(calls).toEqual(['lock', 'update', 'unlock', 'unlock']);
  });
});
