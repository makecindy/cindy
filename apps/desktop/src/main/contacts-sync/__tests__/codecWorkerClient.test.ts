import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  workers: 0,
  activeWorkers: 0,
  maxActiveWorkers: 0,
  terminated: 0,
  respond: false,
  responseDelayMs: 0,
  responseData: undefined as unknown,
  requests: [] as Array<Record<string, unknown>>,
  transferLists: [] as Array<ArrayBuffer[]>,
}));

vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() {
      super();
      harness.workers += 1;
      harness.activeWorkers += 1;
      harness.maxActiveWorkers = Math.max(harness.maxActiveWorkers, harness.activeWorkers);
    }

    postMessage(request: Record<string, unknown>, transferList: ArrayBuffer[] = []): void {
      harness.requests.push(request);
      harness.transferLists.push(transferList);
      if (!harness.respond) return;
      const respond = () => {
        this.emit('message', {
          id: request.id,
          ok: true,
          data:
            harness.responseData ??
            (request.type === 'encode'
              ? {
                  transferId: randomUUID(),
                  total: 1,
                  iv: Buffer.alloc(12).toString('base64'),
                  tag: Buffer.alloc(16).toString('base64'),
                  ciphertext: new Uint8Array([1, 2, 3]),
                  materialized: false,
                }
              : { materialized: false }),
        });
      };
      if (harness.responseDelayMs > 0) setTimeout(respond, harness.responseDelayMs);
      else queueMicrotask(respond);
    }

    async terminate(): Promise<number> {
      harness.terminated += 1;
      harness.activeWorkers -= 1;
      return 0;
    }
  },
}));

const { generateContactsSyncIdentity } = await import('../crypto.js');
const { workerContactsSyncCodec } = await import('../contactsSyncCodecWorkerClient.js');

describe('contacts sync codec worker client', () => {
  beforeEach(() => {
    harness.workers = 0;
    harness.activeWorkers = 0;
    harness.maxActiveWorkers = 0;
    harness.terminated = 0;
    harness.respond = false;
    harness.responseDelayMs = 0;
    harness.responseData = undefined;
    harness.requests = [];
    harness.transferLists = [];
  });

  it('marks an active database worker cancelled and waits for its SQLite task to unwind', async () => {
    harness.respond = true;
    harness.responseDelayMs = 100;
    const own = generateContactsSyncIdentity();
    const peer = generateContactsSyncIdentity();
    const controller = new AbortController();
    const task = workerContactsSyncCodec.encode(
      {
        database: { source: { dbPath: '/tmp/contacts.db' } },
        ownPrivateKey: own.privateKey,
        ownPublicKey: own.publicKey,
        peerPublicKey: peer.publicKey,
        srcDeviceId: 'device-a',
        dstDeviceId: 'device-b',
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
    controller.abort();

    const cancellation = harness.requests[0]?.cancellation;
    expect(cancellation).toBeInstanceOf(SharedArrayBuffer);
    expect(Atomics.load(new Int32Array(cancellation as SharedArrayBuffer), 0)).toBe(1);
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.terminated).toBe(1);
  });

  it('production encode sends only a database descriptor and receives bounded bytes', async () => {
    harness.respond = true;
    const own = generateContactsSyncIdentity();
    const peer = generateContactsSyncIdentity();
    const result = await workerContactsSyncCodec.encode({
      database: {
        source: { dbPath: '/tmp/contacts.db' },
        knownClocks: [{ nodeId: 'node-a', counter: 2 }],
        requestReply: true,
      },
      ownPrivateKey: own.privateKey,
      ownPublicKey: own.publicKey,
      peerPublicKey: peer.publicKey,
      srcDeviceId: 'device-a',
      dstDeviceId: 'device-b',
    });

    expect(result.frames).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      type: 'encode',
      options: {
        database: { source: { dbPath: '/tmp/contacts.db' } },
      },
    });
    expect((harness.requests[0]?.options as { message?: unknown }).message).toBeUndefined();
    expect(harness.transferLists[0]).toEqual([]);
  });

  it('serializes database-bound workers while leaving the general worker budget independent', async () => {
    harness.respond = true;
    harness.responseDelayMs = 100;
    const own = generateContactsSyncIdentity();
    const peer = generateContactsSyncIdentity();
    const options = {
      database: { source: { dbPath: '/tmp/contacts.db' } },
      ownPrivateKey: own.privateKey,
      ownPublicKey: own.publicKey,
      peerPublicKey: peer.publicKey,
      srcDeviceId: 'device-a',
      dstDeviceId: 'device-b',
    };

    const tasks = [
      workerContactsSyncCodec.encode(options),
      workerContactsSyncCodec.encode(options),
    ];
    await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
    expect(harness.maxActiveWorkers).toBe(1);
    await Promise.all(tasks);

    expect(harness.requests).toHaveLength(2);
    expect(harness.maxActiveWorkers).toBe(1);
  });

  it.each([
    [[{ nodeId: 'node-a', counter: 0 }], 'zero counter'],
    [[{ nodeId: 'node with spaces', counter: 1 }], 'invalid node id'],
    [
      [
        { nodeId: 'node-a', counter: 1 },
        { nodeId: 'node-a', counter: 2 },
      ],
      'duplicate node id',
    ],
  ])('rejects applied-state clocks with %s', async (clocks) => {
    harness.respond = true;
    harness.responseData = {
      version: 1,
      type: 'applied-state',
      changed: true,
      clocks,
    };
    const own = generateContactsSyncIdentity();
    const peer = generateContactsSyncIdentity();

    await expect(
      workerContactsSyncCodec.decode({
        ciphertext: new Uint8Array([1, 2, 3]),
        iv: Buffer.alloc(12).toString('base64'),
        tag: Buffer.alloc(16).toString('base64'),
        ownPrivateKey: own.privateKey,
        expectedPeerPublicKey: peer.publicKey,
        srcDeviceId: 'device-b',
        dstDeviceId: 'device-a',
        transferId: randomUUID(),
        totalChunks: 1,
        databaseSource: { dbPath: '/tmp/contacts.db' },
      }),
    ).rejects.toThrow(/invalid contacts sync decode result/);
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
