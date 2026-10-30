import { describe, expect, it } from 'vitest';

import { OwnedInFlight } from '../ownedInFlight';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('OwnedInFlight', () => {
  it('lets callers for the same owner share one read', async () => {
    const inFlight = new OwnedInFlight<string[]>();
    const read = deferred<string[]>();
    let starts = 0;
    const start = () => {
      starts += 1;
      return read.promise;
    };
    const first = inFlight.run('a', start);
    const second = inFlight.run('a', start);
    read.resolve(['a-source']);
    expect(await first).toEqual(['a-source']);
    expect(await second).toEqual(['a-source']);
    expect(starts).toBe(1);
  });

  it('never hands an earlier account its read after a switch', async () => {
    const inFlight = new OwnedInFlight<string[]>();
    const forA = deferred<string[]>();
    const forB = deferred<string[]>();
    const fromA = inFlight.run('a', () => forA.promise);
    const fromB = inFlight.run('b', () => forB.promise);
    forA.resolve(['a-source']);
    forB.resolve(['b-source']);
    expect(await fromA).toEqual(['a-source']);
    expect(await fromB).toEqual(['b-source']);
  });

  it('starts a fresh read once the previous one settled, even if the stale one settles late', async () => {
    const inFlight = new OwnedInFlight<string>();
    const forA = deferred<string>();
    const forB = deferred<string>();
    void inFlight.run('a', () => forA.promise);
    const fromB = inFlight.run('b', () => forB.promise);
    forA.resolve('a');
    await Promise.resolve();
    // A's late settle must not clear B's read: another B caller still joins it.
    let restarted = false;
    const again = inFlight.run('b', () => {
      restarted = true;
      return Promise.resolve('b2');
    });
    forB.resolve('b');
    expect(await fromB).toBe('b');
    expect(await again).toBe('b');
    expect(restarted).toBe(false);
  });
});
