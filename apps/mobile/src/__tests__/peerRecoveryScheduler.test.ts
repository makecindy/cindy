import { describe, expect, it } from 'vitest';
import { resolveHomeConnectionFeedback } from '@/components/connectionBannerVisibility';
import {
  PeerRecoveryScheduler,
} from '@/device-link/peerRecoveryScheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PeerRecoveryScheduler', () => {
  it('hands recovery off to queued Home hydration without exposing the old manual failure', async () => {
    const subscribed = deferred<void>();
    const syncing = new Set<string>();
    const scheduler = new PeerRecoveryScheduler(async (id) => {
      await subscribed.promise;
      // Home reseed marks syncing before its limiter starts the snapshot reads.
      syncing.add(id);
      return { retry: false };
    });
    const failure = { deviceId: 'a', deviceName: 'Mac', error: '[INVOKE_TIMEOUT] failed' };
    const feedback = () => resolveHomeConnectionFeedback(failure, new Set([...scheduler.getActiveDeviceIds(), ...syncing]));
    scheduler.request('a');
    expect(feedback().deviceRecovery).toBe(true);
    subscribed.resolve();
    await flush();
    expect(scheduler.getActiveDeviceIds().size).toBe(0);
    expect(feedback().deviceRecovery).toBe(true);
    syncing.delete('a');
    // A failed hydrate may retain the ordinary error; only now is manual retry available.
    expect(feedback().deviceRecovery).toBe(false);
    expect(resolveHomeConnectionFeedback(null, syncing).error).toBeNull();
  });
});
