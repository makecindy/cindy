import { describe, expect, it, vi } from 'vitest';

import {
  LocalIconRequestGate,
  MAX_CONCURRENT_LOCAL_ICON_REQUESTS,
} from '../localIconRequestGate.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('LocalIconRequestGate', () => {
  it('never starts more than two unsettled Main requests', async () => {
    expect(MAX_CONCURRENT_LOCAL_ICON_REQUESTS).toBe(2);
    const gate = new LocalIconRequestGate();
    const first = deferred<string>();
    const second = deferred<string>();
    const blockedOperation = vi.fn(async () => 'blocked');

    const firstRun = gate.tryRun(() => first.promise);
    const secondRun = gate.tryRun(() => second.promise);

    expect(firstRun).not.toBeNull();
    expect(secondRun).not.toBeNull();
    expect(gate.tryRun(blockedOperation)).toBeNull();
    expect(blockedOperation).not.toHaveBeenCalled();

    first.resolve('first');
    await expect(firstRun).resolves.toBe('first');

    const admittedRun = gate.tryRun(async () => 'admitted');
    await expect(admittedRun).resolves.toBe('admitted');

    second.resolve('second');
    await expect(secondRun).resolves.toBe('second');
  });

  it('releases capacity after rejection and synchronous failure', async () => {
    const gate = new LocalIconRequestGate();
    const rejected = deferred<void>();
    const rejectedRun = gate.tryRun(() => rejected.promise);
    rejected.reject(new Error('failed'));
    await expect(rejectedRun).rejects.toThrow('failed');

    expect(() =>
      gate.tryRun(() => {
        throw new Error('sync failed');
      }),
    ).toThrow('sync failed');

    await expect(gate.tryRun(async () => 'available')).resolves.toBe('available');
  });
});
