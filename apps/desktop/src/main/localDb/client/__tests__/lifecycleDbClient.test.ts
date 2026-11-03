import { describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../DbClient.js';
import { retainDbClient } from '../pendingOperations.js';
import {
  createLifecycleDbClientManager,
  type LifecycleDbClientLog,
} from '../lifecycleDbClient.js';

describe('lifecycle DbClient manager', () => {
  it.each(['worker', 'inproc-fallback'])('keeps the outgoing %s database open until all paid operations settle', async mode => {
    const worker = makeClient('worker');
    const fallback = makeClient('fallback');
    if (mode === 'inproc-fallback') worker.query.mockRejectedValueOnce(new Error('worker unavailable'));
    const clearCurrent = vi.fn();
    const manager = createLifecycleDbClientManager({
      getCurrentDbPath: () => '/tmp/owner-a.db',
      createWorkerClient: vi.fn(async () => worker),
      createInprocClient: vi.fn(async () => fallback),
      setCurrentDbClient: vi.fn(),
      clearCurrentDbClient: clearCurrent,
      log: makeLog(),
    });
    await manager.ensure('owner-a', {});
    const client = mode === 'worker' ? worker : fallback;
    const first = retainDbClient(client);
    const second = retainDbClient(client);
    const disposing = manager.dispose('user-switch');
    expect(clearCurrent).toHaveBeenCalledWith(client);
    await Promise.resolve();
    expect(client.dispose).not.toHaveBeenCalled();
    first();
    first();
    await Promise.resolve();
    expect(client.dispose).not.toHaveBeenCalled();
    second();
    await disposing;
    expect(client.dispose).toHaveBeenCalledOnce();
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
