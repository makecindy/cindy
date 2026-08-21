import { describe, expect, it } from 'vitest';

import { RemoteHostHydrationQueue } from '../hydration-queue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('RemoteHostHydrationQueue', () => {
  it('does not let a newer hydrate overtake one waiting for runtime invalidation', async () => {
    const queue = new RemoteHostHydrationQueue();
    const invalidation = deferred();
    const events: string[] = [];

    const older = queue.run(async () => {
      events.push('older:read');
      await invalidation.promise;
      events.push('older:commit');
    });
    const newer = queue.run(async () => {
      events.push('newer:read');
      events.push('newer:commit');
    });

    await Promise.resolve();
    expect(events).toEqual(['older:read']);

    invalidation.resolve();
    await Promise.all([older, newer]);
    expect(events).toEqual([
      'older:read',
      'older:commit',
      'newer:read',
      'newer:commit',
    ]);
  });

  it('allows a later hydrate after an earlier failure', async () => {
    const queue = new RemoteHostHydrationQueue();
    await expect(queue.run(async () => { throw new Error('read failed'); })).rejects.toThrow('read failed');
    await expect(queue.run(async () => 'recovered')).resolves.toBe('recovered');
  });
});
