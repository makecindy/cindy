import { describe, expect, it, vi } from 'vitest';

import { StableOwnerPostCommitCoordinator } from '../stableOwnerPostCommit';

describe('StableOwnerPostCommitCoordinator', () => {
  it('defers without consuming the scope until its owner boundary is stable', async () => {
    let stable = false;
    const task = vi.fn().mockResolvedValue('completed');
    const coordinator = new StableOwnerPostCommitCoordinator({
      snapshot: () => ({ scopeKey: 'local:owner:1', dataOwnerId: 'owner', stable }),
      warn: vi.fn(),
    });
    coordinator.setTask(task);

    await expect(coordinator.ensure('early')).resolves.toBe('deferred');
    expect(task).not.toHaveBeenCalled();

    stable = true;
    await expect(coordinator.ensure('stable')).resolves.toBe('completed');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent work and memoizes only a completed owner scope', async () => {
    let resolveTask!: (value: 'completed') => void;
    const task = vi.fn(() => new Promise<'completed'>((resolve) => {
      resolveTask = resolve;
    }));
    const coordinator = new StableOwnerPostCommitCoordinator({
      snapshot: () => ({ scopeKey: 'local:owner:1', dataOwnerId: 'owner', stable: true }),
      warn: vi.fn(),
    });
    coordinator.setTask(task);

    const first = coordinator.ensure('first');
    const second = coordinator.ensure('second');
    await vi.waitFor(() => expect(resolveTask).toBeTypeOf('function'));
    resolveTask('completed');

    await expect(Promise.all([first, second])).resolves.toEqual(['completed', 'completed']);
    await expect(coordinator.ensure('later')).resolves.toBe('completed');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('runs and memoizes stable signed-out scopes for account-free post-commit work', async () => {
    const task = vi.fn().mockResolvedValue('completed');
    const coordinator = new StableOwnerPostCommitCoordinator({
      snapshot: () => ({ scopeKey: 'signed-out:none:1', dataOwnerId: null, stable: true }),
      warn: vi.fn(),
    });
    coordinator.setTask(task);

    await expect(coordinator.ensure('signed-out-startup')).resolves.toBe('completed');
    await expect(coordinator.ensure('signed-out-again')).resolves.toBe('completed');
    expect(task).toHaveBeenCalledTimes(1);
    expect(task).toHaveBeenCalledWith({
      reason: 'signed-out-startup',
      scopeKey: 'signed-out:none:1',
      dataOwnerId: null,
    });
  });

  it('retries deferred and failed passes instead of caching false success', async () => {
    const task = vi
      .fn()
      .mockResolvedValueOnce('deferred')
      .mockRejectedValueOnce(new Error('disk busy'))
      .mockResolvedValueOnce('completed');
    const warn = vi.fn();
    const coordinator = new StableOwnerPostCommitCoordinator({
      snapshot: () => ({ scopeKey: 'local:owner:1', dataOwnerId: 'owner', stable: true }),
      warn,
    });
    coordinator.setTask(task);

    await expect(coordinator.ensure('deferred')).resolves.toBe('deferred');
    await expect(coordinator.ensure('failed')).resolves.toBe('failed');
    await expect(coordinator.ensure('retry')).resolves.toBe('completed');
    expect(task).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not complete a stale scope when the owner changes during the task', async () => {
    let scopeKey = 'local:owner:1';
    const task = vi.fn(async () => {
      scopeKey = 'cloud:other:2';
      return 'completed' as const;
    });
    const coordinator = new StableOwnerPostCommitCoordinator({
      snapshot: () => ({ scopeKey, dataOwnerId: scopeKey.includes('other') ? 'other' : 'owner', stable: true }),
      warn: vi.fn(),
    });
    coordinator.setTask(task);

    await expect(coordinator.ensure('owner-change')).resolves.toBe('deferred');
  });

  it('automatically retries a failed stable scope without another external ensure', async () => {
    const scheduled: Array<() => void> = [];
    const task = vi
      .fn()
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('completed');
    const coordinator = new StableOwnerPostCommitCoordinator({
      snapshot: () => ({ scopeKey: 'local:owner:1', dataOwnerId: 'owner', stable: true }),
      warn: vi.fn(),
      retryDelaysMs: [1],
      scheduleRetry: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancelRetry: vi.fn(),
    });
    coordinator.setTask(task);

    await expect(coordinator.ensure('initial')).resolves.toBe('failed');
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    await expect(coordinator.ensure('after-retry')).resolves.toBe('completed');
  });

  it('drops a scheduled retry when the owner scope changes', async () => {
    let scopeKey = 'local:owner:1';
    const scheduled: Array<() => void> = [];
    const task = vi.fn().mockResolvedValue('failed');
    const coordinator = new StableOwnerPostCommitCoordinator({
      snapshot: () => ({
        scopeKey,
        dataOwnerId: scopeKey.includes('other') ? 'other' : 'owner',
        stable: true,
      }),
      warn: vi.fn(),
      retryDelaysMs: [1],
      scheduleRetry: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancelRetry: vi.fn(),
    });
    coordinator.setTask(task);

    await expect(coordinator.ensure('initial')).resolves.toBe('failed');
    scopeKey = 'cloud:other:2';
    scheduled.shift()?.();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
  });
});
