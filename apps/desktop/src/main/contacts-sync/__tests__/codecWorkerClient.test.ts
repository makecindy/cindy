import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ workers: 0 }));

vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() {
      super();
      harness.workers += 1;
    }

    postMessage(): void {}

    async terminate(): Promise<number> {
      return 0;
    }
  },
}));

const { generateContactsSyncIdentity } = await import('../crypto.js');
const { workerContactsSyncCodec } = await import('../contactsSyncCodecWorkerClient.js');

describe('contacts sync codec worker client', () => {
  beforeEach(() => {
    harness.workers = 0;
  });

  it('bounds the global queue and aborts active plus queued owner work', async () => {
    const own = generateContactsSyncIdentity();
    const peer = generateContactsSyncIdentity();
    const options = {
      message: { version: 1 as const, type: 'state' as const, state: { contacts: [] } },
      ownPrivateKey: own.privateKey,
      ownPublicKey: own.publicKey,
      peerPublicKey: peer.publicKey,
      srcDeviceId: 'device-a',
      dstDeviceId: 'device-b',
    };
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const tasks = controllers.map((controller) =>
      workerContactsSyncCodec.encode(options, controller.signal),
    );
    await vi.waitFor(() => expect(harness.workers).toBe(2));

    await expect(
      workerContactsSyncCodec.encode(options, new AbortController().signal),
    ).rejects.toThrow(/queue is full/);

    for (const controller of controllers) controller.abort();
    const results = await Promise.allSettled(tasks);
    expect(results).toHaveLength(10);
    expect(
      results.every(
        (result) => result.status === 'rejected' && result.reason?.name === 'AbortError',
      ),
    ).toBe(true);
  });
});
