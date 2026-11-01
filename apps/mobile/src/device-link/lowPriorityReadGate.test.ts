import { describe, expect, it, vi } from 'vitest';
import { createLowPriorityReadGate, isLowPriorityRead } from './lowPriorityReadGate';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

describe('lowPriorityReadGate', () => {
  it('only covers refresh reads, never writes or resource actions', () => {
    expect(isLowPriorityRead('git-context:pr-status')).toBe(true);
    expect(isLowPriorityRead('maker:remote-resources:list')).toBe(true);
    expect(isLowPriorityRead('maker:remote-resources:invoke')).toBe(false);
    expect(isLowPriorityRead('maker:send')).toBe(false);
  });

  it('never runs more than the limit, and starts the next read as one settles', async () => {
    const gate = createLowPriorityReadGate(2);
    const tasks = [deferred<number>(), deferred<number>(), deferred<number>()];
    const started = tasks.map(() => vi.fn());
    const results = tasks.map((task, index) => gate.run(null, () => {
      started[index]();
      return task.promise;
    }));
    await flush();
    expect(started.map((fn) => fn.mock.calls.length)).toEqual([1, 1, 0]);
    tasks[0].resolve(0);
    await flush();
    expect(started[2]).toHaveBeenCalledTimes(1);
    tasks[1].resolve(1);
    tasks[2].resolve(2);
    await expect(Promise.all(results)).resolves.toEqual([0, 1, 2]);
  });

  it('joins an identical read that is still queued', async () => {
    const gate = createLowPriorityReadGate(1);
    const blocker = deferred<string>();
    const first = gate.run('blocker', () => blocker.promise);
    const task = vi.fn(async () => 'shared');
    const joined = [gate.run('same', task), gate.run('same', task), gate.run('same', task)];
    blocker.resolve('done');
    await first;
    await expect(Promise.all(joined)).resolves.toEqual(['shared', 'shared', 'shared']);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('does not share a read already on the wire, so a later refresh sees later data', async () => {
    const gate = createLowPriorityReadGate(2);
    const inFlight = deferred<string>();
    const first = gate.run('same', () => inFlight.promise);
    await flush();
    const later = vi.fn(async () => 'fresh');
    await expect(gate.run('same', later)).resolves.toBe('fresh');
    expect(later).toHaveBeenCalledTimes(1);
    inFlight.resolve('stale');
    await expect(first).resolves.toBe('stale');
  });

  it('never coalesces a read without a key', async () => {
    const gate = createLowPriorityReadGate(1);
    const blocker = deferred<void>();
    const first = gate.run(null, () => blocker.promise);
    const task = vi.fn(async () => 1);
    const others = [gate.run(null, task), gate.run(null, task)];
    blocker.resolve();
    await first;
    await Promise.all(others);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('rejects every joined caller and keeps draining after a failure', async () => {
    const gate = createLowPriorityReadGate(1);
    const blocker = deferred<void>();
    void gate.run(null, () => blocker.promise);
    const failing = gate.run('a', async () => { throw new Error('boom'); });
    const joined = gate.run('a', async () => 'unused');
    const next = gate.run('b', async () => 'next');
    blocker.resolve();
    await expect(failing).rejects.toThrow('boom');
    await expect(joined).rejects.toThrow('boom');
    await expect(next).resolves.toBe('next');
  });

  it('rejects a read that waited past the deadline without ever starting it', async () => {
    vi.useFakeTimers();
    try {
      const gate = createLowPriorityReadGate(1, 1_000);
      const blocker = deferred<void>();
      void gate.run(null, () => blocker.promise);
      const stale = vi.fn(async () => 'late');
      const waiting = gate.run('stale', stale);
      const caught = expect(waiting).rejects.toMatchObject({ code: 'BACKPRESSURE' });
      await vi.advanceTimersByTimeAsync(1_000);
      await caught;
      blocker.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(stale).not.toHaveBeenCalled();
      // The expired key is free again: a new identical read queues and runs normally.
      await expect(gate.run('stale', async () => 'fresh')).resolves.toBe('fresh');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses instead of growing without bound', async () => {
    const gate = createLowPriorityReadGate(1);
    const blocker = deferred<void>();
    void gate.run(null, () => blocker.promise);
    const queued = Array.from({ length: 256 }, () => gate.run(null, async () => undefined));
    await flush();
    await expect(gate.run(null, async () => undefined)).rejects.toMatchObject({ code: 'BACKPRESSURE' });
    blocker.resolve();
    await Promise.all(queued);
  });
});
