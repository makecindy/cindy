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
      quarantineMainDb: vi.fn(),
      closeMainDb: vi.fn(), getCurrentDbPath: () => '/tmp/owner-a.db',
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
      quarantineMainDb: vi.fn(),
      closeMainDb: vi.fn(), getCurrentDbPath: () => 'C:/Users/test/xdt-maker.db',
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
      quarantineMainDb: vi.fn(),
      closeMainDb: vi.fn(), getCurrentDbPath: () => 'C:/Users/test/xdt-maker.db',
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
      quarantineMainDb: vi.fn(),
      closeMainDb: vi.fn(), getCurrentDbPath: () => 'C:/Users/test/xdt-maker.db',
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
      quarantineMainDb: vi.fn(),
      closeMainDb: vi.fn(), getCurrentDbPath: () => 'C:/Users/test/xdt-maker.db',
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
  it('requires explicit recovery for a corrupt client and ignores retired callbacks', async () => {
    const clients = [makeClient('a'), makeClient('retry'), makeClient('b')];
    const callbacks: Array<() => void> = [];
    const report = vi.fn();
    const quarantine = vi.fn();
    let index = 0;
    const manager = createLifecycleDbClientManager({
      quarantineMainDb: quarantine,
      closeMainDb: vi.fn(), getCurrentDbPath: () => 'synthetic.db',
      createWorkerClient: vi.fn(async (options) => {
        callbacks.push(() => options.onCorruption?.(Object.assign(new Error('corrupt'), { code: 'SQLITE_CORRUPT' })));
        return clients[index++];
      }),
      createInprocClient: vi.fn(), setCurrentDbClient: vi.fn(), clearCurrentDbClient: vi.fn(), log: makeLog(),
    });
    await manager.ensure('owner-a', { onCorruption: report });
    callbacks[0]();
    expect(quarantine).toHaveBeenCalledWith('owner-a', expect.objectContaining({ code: 'SQLITE_CORRUPT' }));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: 'SQLITE_CORRUPT' }));
    const currentGenerationReport = vi.fn();
    await manager.ensure('owner-a', { onCorruption: currentGenerationReport });
    report.mockClear();
    callbacks[0]();
    expect(report).not.toHaveBeenCalled();
    expect(currentGenerationReport).toHaveBeenCalledOnce();
    Object.defineProperty(clients[0], 'corruptionError', { value: new Error('corrupt') });
    await expect(manager.ensure('owner-a', {})).rejects.toThrow('corrupt');
    await manager.prepareForEnsure('owner-a', true);
    await manager.ensure('owner-a', {});
    expect(clients[0].dispose).toHaveBeenCalledOnce();
    report.mockClear();
    quarantine.mockClear();
    callbacks[0]();
    expect(quarantine).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    await manager.ensure('owner-b', {});
    callbacks[1]();
    expect(quarantine).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    await manager.dispose('test-end');
  });
  // #9555 / unit: a failed native close must not turn the next passive ensure
  // into a recovery attempt, even after the worker has released main's dbPath.
  it('preserves quarantine when native closure fails and does not close a new owner during retained work', async () => {
    const worker = makeClient('corrupt');
    const corruption = Object.assign(new Error('bad page'), { code: 'SQLITE_CORRUPT' });
    const closeMainDb = vi.fn(() => { throw new Error('native close failed'); });
    const manager = createLifecycleDbClientManager({
      quarantineMainDb: vi.fn(),
      getCurrentDbPath: () => 'synthetic.db', closeMainDb,
      createWorkerClient: async () => worker, createInprocClient: vi.fn(),
      setCurrentDbClient: vi.fn(), clearCurrentDbClient: vi.fn(), log: makeLog(),
    });
    await manager.ensure('owner-a', {});
    Object.defineProperty(worker, 'corruptionError', { value: corruption });
    await expect(manager.prepareForEnsure('owner-a', true)).rejects.toThrow('native close failed');
    await expect(manager.ensure('owner-a', {})).rejects.toBe(corruption);
    const release = retainDbClient(worker);
    const recovering = manager.prepareForEnsure('owner-a', true);
    const outgoing = manager.dispose('owner-switch');
    release();
    await Promise.all([recovering, outgoing]);
    expect(closeMainDb).toHaveBeenCalledOnce();
  });

  it('leaves the quarantined handle untouched when recovery becomes stale while work is retained', async () => {
    const worker = makeClient('corrupt');
    const closeMainDb = vi.fn();
    const manager = createLifecycleDbClientManager({
      quarantineMainDb: vi.fn(),
      getCurrentDbPath: () => 'synthetic.db', closeMainDb,
      createWorkerClient: async () => worker, createInprocClient: vi.fn(),
      setCurrentDbClient: vi.fn(), clearCurrentDbClient: vi.fn(), log: makeLog(),
    });
    await manager.ensure('owner-a', {});
    const corruption = Object.assign(new Error('bad page'), { code: 'SQLITE_CORRUPT' });
    Object.defineProperty(worker, 'corruptionError', { value: corruption });
    const release = retainDbClient(worker);
    let current = true;
    const recovering = manager.prepareForEnsure('owner-a', true, () => current);
    current = false;
    release();
    await recovering;
    expect(closeMainDb).not.toHaveBeenCalled();
    expect(worker.dispose).not.toHaveBeenCalled();
    await expect(manager.ensure('owner-a', {})).rejects.toBe(corruption);
    await manager.dispose('test-end');
  });

  it('never retries a corrupt worker through the inproc fallback', async () => {
    const worker = makeClient('corrupt');
    const corruption = Object.assign(new Error('corrupt'), { code: 'SQLITE_CORRUPT' });
    Object.defineProperty(worker, 'corruptionError', { value: corruption });
    worker.query.mockRejectedValue(corruption);
    const fallback = vi.fn();
    const report = vi.fn();
    const manager = createLifecycleDbClientManager({ quarantineMainDb: vi.fn(), closeMainDb: vi.fn(), getCurrentDbPath: () => 'synthetic.db',
      createWorkerClient: vi.fn(async () => worker), createInprocClient: fallback,
      setCurrentDbClient: vi.fn(), clearCurrentDbClient: vi.fn(), log: makeLog() });
    await expect(manager.ensure('owner-a', { onCorruption: report })).rejects.toMatchObject({ code: 'SQLITE_CORRUPT' });
    expect(report).toHaveBeenCalledWith(corruption);
    expect(fallback).not.toHaveBeenCalled();
    expect(worker.dispose).not.toHaveBeenCalled();
    await expect(manager.ensure('owner-a', {})).rejects.toMatchObject({ code: 'SQLITE_CORRUPT' });
    await manager.dispose('test-end');
    expect(worker.dispose).toHaveBeenCalledOnce();
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
