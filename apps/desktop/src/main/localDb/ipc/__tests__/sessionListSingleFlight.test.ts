import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildSessionListFlightKey,
  bumpSessionListWriteGeneration,
  resetSessionListSingleFlightForTests,
  runSessionListSingleFlight,
} from '../sessionListSingleFlight';
import { noteSessionListDbWrite } from '../../client/sessionListWriteGeneration';

afterEach(() => {
  resetSessionListSingleFlightForTests();
});

describe('buildSessionListFlightKey', () => {
  it('uses normalized status all for null filter', () => {
    expect(
      buildSessionListFlightKey({
        userId: 'u1',
        cap: 200,
        statusFilter: null,
        includePinned: true,
      }),
    ).toBe('u1|all|200|pinned|g0');
  });

  it('separates filter, cap, pinned, and userId', () => {
    const base = {
      userId: 'u1',
      cap: 200,
      statusFilter: 'active' as const,
      includePinned: true,
    };
    expect(buildSessionListFlightKey(base)).toBe('u1|active|200|pinned|g0');
    expect(buildSessionListFlightKey({ ...base, statusFilter: null })).not.toBe(
      buildSessionListFlightKey(base),
    );
    expect(buildSessionListFlightKey({ ...base, cap: 1000 })).not.toBe(
      buildSessionListFlightKey(base),
    );
    expect(buildSessionListFlightKey({ ...base, includePinned: false })).toBe(
      'u1|active|200|plain|g0',
    );
    expect(buildSessionListFlightKey({ ...base, userId: 'u2' })).not.toBe(
      buildSessionListFlightKey(base),
    );
  });
});

describe('runSessionListSingleFlight', () => {
  it('coalesces concurrent callers with the same key into one run', async () => {
    let calls = 0;
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      calls += 1;
      return gate;
    });

    const a = runSessionListSingleFlight('k', run);
    const b = runSessionListSingleFlight('k', run);
    const c = runSessionListSingleFlight('k', run);
    expect(run).toHaveBeenCalledTimes(1);

    release('same');
    await expect(Promise.all([a, b, c])).resolves.toEqual(['same', 'same', 'same']);
    expect(calls).toBe(1);
  });

  it('does not coalesce different keys', async () => {
    const runA = vi.fn(async () => 'a');
    const runB = vi.fn(async () => 'b');
    const runC = vi.fn(async () => 'c');
    await expect(
      Promise.all([
        runSessionListSingleFlight('active|200|pinned', runA),
        runSessionListSingleFlight('all|1000|plain', runB),
        runSessionListSingleFlight('all|1|pinned', runC),
      ]),
    ).resolves.toEqual(['a', 'b', 'c']);
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
    expect(runC).toHaveBeenCalledTimes(1);
  });

  it('runs again after the previous flight settles', async () => {
    const run = vi.fn(async () => 'ok');
    await runSessionListSingleFlight('k', run);
    await runSessionListSingleFlight('k', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects every joiner and does not stick the error', async () => {
    const boom = new Error('db busy');
    const failing = vi.fn(async () => {
      throw boom;
    });
    const first = runSessionListSingleFlight('k', failing);
    const second = runSessionListSingleFlight('k', failing);
    await expect(first).rejects.toBe(boom);
    await expect(second).rejects.toBe(boom);
    expect(failing).toHaveBeenCalledTimes(1);

    const recovering = vi.fn(async () => 'recovered');
    await expect(runSessionListSingleFlight('k', recovering)).resolves.toBe('recovered');
    expect(recovering).toHaveBeenCalledTimes(1);
  });

  it('does not join a later user onto an earlier user flight', async () => {
    let releaseU1!: (value: string) => void;
    const u1Gate = new Promise<string>((resolve) => {
      releaseU1 = resolve;
    });
    const u1 = runSessionListSingleFlight(
      buildSessionListFlightKey({
        userId: 'u1',
        cap: 200,
        statusFilter: 'active',
        includePinned: true,
      }),
      async () => u1Gate,
    );
    const u2Run = vi.fn(async () => 'u2');
    const u2 = runSessionListSingleFlight(
      buildSessionListFlightKey({
        userId: 'u2',
        cap: 200,
        statusFilter: 'active',
        includePinned: true,
      }),
      u2Run,
    );

    await expect(u2).resolves.toBe('u2');
    expect(u2Run).toHaveBeenCalledTimes(1);
    releaseU1('u1');
    await expect(u1).resolves.toBe('u1');
  });

  it('does not join a refresh after a list-projection write', async () => {
    const params = {
      userId: 'u1',
      cap: 200,
      statusFilter: 'active' as const,
      includePinned: true,
    };
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const first = runSessionListSingleFlight(buildSessionListFlightKey(params), async () => gate);
    noteSessionListDbWrite({ sql: 'INSERT INTO sessions (id) VALUES (?)' });
    const afterWrite = vi.fn(async () => 'fresh');
    const second = runSessionListSingleFlight(buildSessionListFlightKey(params), afterWrite);
    await expect(second).resolves.toBe('fresh');
    expect(afterWrite).toHaveBeenCalledTimes(1);
    release('stale');
    await expect(first).resolves.toBe('stale');
  });

  it('does not join a later client onto an earlier client flight after owner swap', async () => {
    const params = {
      userId: 'u1',
      cap: 200,
      statusFilter: 'active' as const,
      includePinned: true,
    };
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const first = runSessionListSingleFlight(buildSessionListFlightKey(params), async () => gate);
    bumpSessionListWriteGeneration();
    const afterSwap = vi.fn(async () => 'new-client');
    const second = runSessionListSingleFlight(buildSessionListFlightKey(params), afterSwap);
    await expect(second).resolves.toBe('new-client');
    expect(afterSwap).toHaveBeenCalledTimes(1);
    release('old-client');
    await expect(first).resolves.toBe('old-client');
  });
});
