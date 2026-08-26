import { describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../DbClient.js';
import {
  createLifecycleDbClientManager,
  type LifecycleDbClientLog,
} from '../lifecycleDbClient.js';

describe('lifecycle DbClient manager', () => {
  it('drains tracked writes before disposing the active DbClient', async () => {
    const worker = makeClient('worker');
    worker.query.mockResolvedValueOnce([{ c: 7 }]);
    const order: string[] = [];
    const beforeDispose = vi.fn(async () => {
      order.push('drain');
    });
    worker.dispose.mockImplementation(async () => {
      order.push('dispose');
    });

    const manager = createLifecycleDbClientManager({
      getCurrentDbPath: () => 'C:/Users/test/xdt-maker.db',
      createWorkerClient: vi.fn(async () => worker),
      createInprocClient: vi.fn(),
      setCurrentDbClient: vi.fn(),
      clearCurrentDbClient: vi.fn(),
      beforeDispose,
      log: makeLog(),
    });

    await manager.ensure('user-1', { drizzleDir: 'C:/repo/apps/desktop/drizzle' });
    await manager.dispose('logout');

    expect(beforeDispose).toHaveBeenCalledWith('logout');
    expect(order).toEqual(['drain', 'dispose']);
  });

  it('warns and still disposes when the pre-dispose drain hook fails', async () => {
    const worker = makeClient('worker');
    worker.query.mockResolvedValueOnce([{ c: 7 }]);
    const log = makeLog();
    const manager = createLifecycleDbClientManager({
      getCurrentDbPath: () => 'C:/Users/test/xdt-maker.db',
      createWorkerClient: vi.fn(async () => worker),
      createInprocClient: vi.fn(),
      setCurrentDbClient: vi.fn(),
      clearCurrentDbClient: vi.fn(),
      beforeDispose: vi.fn(async () => {
        throw new Error('drain failed');
      }),
      log,
    });

    await manager.ensure('user-1', { drizzleDir: 'C:/repo/apps/desktop/drizzle' });
    await expect(manager.dispose('quit')).resolves.toBeUndefined();

    expect(worker.dispose).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('[DbClient] before-dispose hook failed', {
      reason: 'quit',
      error: 'drain failed',
    });
  });

  it('keeps main db active and installs inproc fallback when worker smoke fails', async () => {
    const worker = makeClient('worker');
    const fallback = makeClient('fallback');
    worker.query.mockRejectedValueOnce(new Error('missing worker bundle'));
    const log = makeLog();
    const setCurrent = vi.fn();

    const manager = createLifecycleDbClientManager({
      getCurrentDbPath: () => 'C:/Users/test/xdt-maker.db',
      createWorkerClient: vi.fn(async () => worker),
      createInprocClient: vi.fn(async () => fallback),
      setCurrentDbClient: setCurrent,
      clearCurrentDbClient: vi.fn(),
      log,
    });

    const result = await manager.ensure('user-1', {
      drizzleDir: 'C:/repo/apps/desktop/drizzle',
    });

    expect(result).toEqual({
      mode: 'inproc-fallback',
      shouldReleaseMainDb: false,
    });
    expect(worker.dispose).toHaveBeenCalledTimes(1);
    expect(setCurrent).toHaveBeenCalledWith(fallback, 'user-1');
    expect(log.error).toHaveBeenCalledWith(
      '[DbClient] worker smoke failed; main localDb path remains active',
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      '[DbClient] inproc fallback active after worker takeover failed',
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('releases main db only after worker smoke succeeds', async () => {
    const worker = makeClient('worker');
    worker.query.mockResolvedValueOnce([{ c: 7 }]);
    const setCurrent = vi.fn();

    const manager = createLifecycleDbClientManager({
      getCurrentDbPath: () => 'C:/Users/test/xdt-maker.db',
      createWorkerClient: vi.fn(async () => worker),
      createInprocClient: vi.fn(),
      setCurrentDbClient: setCurrent,
      clearCurrentDbClient: vi.fn(),
      log: makeLog(),
    });

    const result = await manager.ensure('user-1', {
      drizzleDir: 'C:/repo/apps/desktop/drizzle',
    });

    expect(result).toEqual({
      mode: 'worker',
      shouldReleaseMainDb: true,
    });
    expect(setCurrent).toHaveBeenCalledWith(worker, 'user-1');
  });

  it('releases a reopened main db when a worker client re-enters for the same user', async () => {
    const worker = makeClient('worker');
    worker.query.mockResolvedValueOnce([{ c: 7 }]);
    const createWorkerClient = vi.fn(async () => worker);

    const manager = createLifecycleDbClientManager({
      getCurrentDbPath: () => 'C:/Users/test/xdt-maker.db',
      createWorkerClient,
      createInprocClient: vi.fn(),
      setCurrentDbClient: vi.fn(),
      clearCurrentDbClient: vi.fn(),
      log: makeLog(),
    });

    await expect(manager.ensure('user-1', {
      drizzleDir: 'C:/repo/apps/desktop/drizzle',
    })).resolves.toEqual({
      mode: 'worker',
      shouldReleaseMainDb: true,
    });
    await expect(manager.ensure('user-1', {
      drizzleDir: 'C:/repo/apps/desktop/drizzle',
    })).resolves.toEqual({
      mode: 'unchanged',
      shouldReleaseMainDb: true,
    });
    expect(createWorkerClient).toHaveBeenCalledTimes(1);
  });

  it('keeps main db active when an inproc fallback re-enters for the same user', async () => {
    const worker = makeClient('worker');
    const fallback = makeClient('fallback');
    worker.query.mockRejectedValueOnce(new Error('missing worker bundle'));
    const createWorkerClient = vi.fn(async () => worker);

    const manager = createLifecycleDbClientManager({
      getCurrentDbPath: () => 'C:/Users/test/xdt-maker.db',
      createWorkerClient,
      createInprocClient: vi.fn(async () => fallback),
      setCurrentDbClient: vi.fn(),
      clearCurrentDbClient: vi.fn(),
      log: makeLog(),
    });

    await expect(manager.ensure('user-1', {
      drizzleDir: 'C:/repo/apps/desktop/drizzle',
    })).resolves.toEqual({
      mode: 'inproc-fallback',
      shouldReleaseMainDb: false,
    });
    await expect(manager.ensure('user-1', {
      drizzleDir: 'C:/repo/apps/desktop/drizzle',
    })).resolves.toEqual({
      mode: 'unchanged',
      shouldReleaseMainDb: false,
    });
    expect(createWorkerClient).toHaveBeenCalledTimes(1);
  });
});

function makeClient(label: string): DbClient & {
  query: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(async () => [{ label }]),
    queryOne: vi.fn(),
    exec: vi.fn(),
    tx: vi.fn(),
    drizzle: {} as DbClient['drizzle'],
    vecAvailable: false,
    dispose: vi.fn(),
  } as DbClient & {
    query: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
}

function makeLog(): LifecycleDbClientLog {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
