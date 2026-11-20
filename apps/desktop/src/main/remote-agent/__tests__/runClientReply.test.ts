/**
 * 反向请求回包交付：链路抖动导致 reply 发送失败时必须重试——对方一直在等同一
 * requestId 的回包，只记日志不重试会让任务停在权限确认 / 工具请求上无法推进。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseRemoteAgentRequest, type RemoteAgentPayload } from '@cindy/device-link';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeviceUnresponsiveError } from '../../device-link/responsivenessTracker';
import { RemoteAgentPoller } from '../controller/poller';
import { remoteAgentInvoker, remoteAgentLinkError, RemoteAgentRunClient } from '../controller/runClient';

afterEach(() => vi.useRealTimers());

// Unit regression: the production open/payload entry must deliver over a slow
// relay without a single upload/inline request outliving its 30s deadline.
// Reply-retry coverage did not exercise byte-paced delivery or old receivers'
// chunk-count ceiling. The link below models 16 KiB/s + 1s RTT without waiting;
// gzip, request parsing and complete payload reconstruction remain real.
describe('RemoteAgentRunClient slow payload delivery', () => {
  // Unit: preparation guards did not cover time in Device Link admission. Stop
  // could overtake that queue and the old send would start afterwards. Exercise
  // the real run client + production invoker, delaying only the wire boundary.
  it.each(['stop', 'signal', 'ended'] as const)('never dispatches a queued send after %s', async mode => {
    const oldId = randomUUID(), stopId = randomUUID(), freshId = randomUUID();
    let release!: () => void;
    let queued!: () => void;
    const admitted = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { queued = resolve; });
    const delivered: string[] = [];
    const invoke = remoteAgentInvoker('host', async (_device, _channel, args, options) => {
      const request = parseRemoteAgentRequest(args[0]);
      if (request.op === 'call') {
        if (request.callId === oldId) { queued(); await admitted; }
        options?.beforeDispatch?.();
        delivered.push(request.callId);
        client.onData(Buffer.from(`${JSON.stringify({ t: 'result', callId: request.callId, ok: true, value: null })}\n`), false);
      }
      return { ok: true, result: {} };
    });
    const client = new RemoteAgentRunClient(randomUUID(), { invoke, unregister() {} } as unknown as RemoteAgentPoller, {
      onEvent() {}, onState() {}, onWs() {}, onClosed() {},
      onRequest: async () => ({ type: 'callback', value: null }),
    }, randomUUID);
    const abort = new AbortController();
    const old = client.callWithId(oldId, 'send', ['hello'], abort.signal);
    const rejected = expect(old).rejects.toThrow(mode === 'ended' ? 'ended' : 'cancelled');
    await waiting;
    if (mode === 'stop') await client.callWithId(stopId, 'abort', []);
    else if (mode === 'signal') abort.abort();
    else client.abandon('ended');
    release(); await rejected;
    expect(delivered).toEqual(mode === 'stop' ? [stopId] : []);
    if (mode !== 'ended') {
      await client.callWithId(freshId, 'send', ['fresh']);
      expect(delivered.filter(id => id === freshId)).toHaveLength(1);
    }
    client.abandon('fixture-complete');
  });

  it.each(['small', 'inline', 'utf8', 'upload', 'large-compatible'] as const)(
    'starts exactly once with an intact %s payload over the bounded link', async kind => {
      const text = kind === 'small' ? 'hello'
        : kind === 'utf8' ? '🙂'.repeat(150 * 1024)
          : randomBytes((kind === 'inline' ? 450 : kind === 'upload' ? 800 : 10 * 1024) * 1024).toString('base64');
      const input = { sessionId: 'slow-payload-fixture', text };
      const uploads = new Map<number, Buffer>();
      const deliveryTimes: number[] = [];
      let opened = 0;
      let delivered: unknown;
      let reference: RemoteAgentPayload | undefined;
      const invoke = async (args: unknown[]) => {
        const request = parseRemoteAgentRequest(args[0]);
        const wireBytes = Buffer.byteLength(JSON.stringify({ channel: 'maker:remote-agent:v1', args }));
        const deliveryMs = Math.ceil(wireBytes / (16 * 1024) * 1000) + 1000;
        deliveryTimes.push(deliveryMs);
        if (deliveryMs > 30_000) throw new Error('INVOKE_TIMEOUT: payload exceeded the response deadline');
        if (request.op === 'upload') {
          uploads.set(request.index, Buffer.from(request.data, 'base64'));
        } else if (request.op === 'open') {
          opened++;
          reference = request.payload;
          delivered = 'json' in request.payload ? request.payload.json
            : JSON.parse(gunzipSync(Buffer.concat(Array.from({ length: request.payload.chunks }, (_, index) => {
              const chunk = uploads.get(index);
              if (!chunk) throw new Error('Missing upload chunk');
              return chunk;
            }))).toString('utf8'));
        }
        return {};
      };
      const client = new RemoteAgentRunClient(randomUUID(), {
        invoke,
        register(run: { onData(data: Buffer, done: boolean): void }) {
          run.onData(Buffer.from(`${JSON.stringify({ t: 'started', handle: { id: 'native-fixture' } })}\n`), false);
        },
        unregister() {},
      } as unknown as RemoteAgentPoller, {
        onEvent() {}, onState() {}, onWs() {}, onClosed() {},
        onRequest: async () => ({ type: 'callback', value: null }),
      }, randomUUID);
      await expect(client.open('claude-code', input)).resolves.toEqual({ id: 'native-fixture' });
      expect(opened).toBe(1);
      expect(delivered).toEqual(input);
      expect(Math.max(...deliveryTimes)).toBeLessThan(30_000);
      if (kind === 'small') {
        expect(uploads.size).toBe(0);
        expect(reference).toEqual({ json: input });
      } else {
        expect(uploads.size).toBeGreaterThan(0);
      }
      if (kind === 'large-compatible') {
        // Preserve the released wire contract, including payloads that need
        // larger slices to stay within its 128-part upload reference.
        expect(uploads.size).toBeLessThanOrEqual(128);
        expect(Math.max(...[...uploads.values()].map(chunk => chunk.length))).toBeGreaterThan(64 * 1024);
      }
      client.abandon('fixture-complete');
    },
  );

  // Unit regression: Stop must overtake an upload without letting the old
  // send/steer start afterwards. Existing abandon tests close the whole client
  // and miss cancellation while the connection remains usable for a new send.
  it.each(['abort', 'requestGracefulStop', 'signal'] as const)(
    '%s cancels a pending send during compression and a steer during upload', async stop => {
      for (const phase of ['compression', 'upload'] as const) {
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let uploading!: () => void;
        const firstUpload = new Promise<void>(resolve => { uploading = resolve; });
        const requests: Array<{ op: string; method?: string }> = [];
        const client = new RemoteAgentRunClient(randomUUID(), {
          async invoke(args: unknown[]) {
            const request = parseRemoteAgentRequest(args[0]);
            requests.push(request);
            if (request.op === 'upload' && phase === 'upload') {
              uploading();
              await held;
              throw Object.assign(new Error('queue full'), { code: 'BACKPRESSURE' });
            }
            if (request.op === 'call') client.onData(Buffer.from(`${JSON.stringify({
              t: 'result', callId: request.callId, ok: true, value: null,
            })}\n`), false);
            return {};
          },
          unregister() {},
        } as unknown as RemoteAgentPoller, {
          onEvent() {}, onState() {}, onWs() {}, onClosed() {},
          onRequest: async () => ({ type: 'callback', value: null }),
        }, randomUUID);
        const abort = new AbortController();
        const sending = client.callWithId(randomUUID(), phase === 'compression' ? 'send' : 'steer',
          [randomBytes(70 * 1024).toString('base64')], stop === 'signal' ? abort.signal : undefined);
        const outcome = sending.then(() => null, error => error as Error);
        if (phase === 'upload') await firstUpload;
        if (stop === 'signal') abort.abort();
        else await client.call(stop, []);
        release();
        expect(await outcome).toMatchObject({ name: 'AbortError' });
        expect(requests.filter(request => request.op === 'call').map(request => request.method))
          .toEqual(stop === 'signal' ? [] : [stop]);
        expect(requests.filter(request => request.op === 'upload')).toHaveLength(phase === 'upload' ? 1 : 0);
        await expect(client.call('send', ['fresh message'])).resolves.toBeNull();
        expect(client.hasPendingWork).toBe(false);
        client.abandon('fixture-complete');
      }
    },
  );

  it('keeps the original result when cancellation follows business dispatch', async () => {
    let entered!: () => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    let complete!: () => void;
    const acknowledged = new Promise<void>(resolve => { complete = resolve; });
    const callId = randomUUID();
    const client = new RemoteAgentRunClient(randomUUID(), {
      async invoke() { entered(); await acknowledged; return {}; },
      unregister() {},
    } as unknown as RemoteAgentPoller, {
      onEvent() {}, onState() {}, onWs() {}, onClosed() {},
      onRequest: async () => ({ type: 'callback', value: null }),
    }, randomUUID);
    const abort = new AbortController();
    const sending = client.callWithId(callId, 'send', ['accepted message'], abort.signal);
    await dispatched;
    abort.abort();
    client.onData(Buffer.from(`${JSON.stringify({ t: 'result', callId, ok: true, value: 'accepted' })}\n`), false);
    complete();
    await expect(sending).resolves.toBe('accepted');
    expect(client.hasPendingWork).toBe(false);
    client.abandon('fixture-complete');
  });

  // Closing during preparation rejects both the internal result and the public
  // call. Vitest must see no orphaned rejection after the caller handles it.
  it('rejects a preparing call on close without an unhandled internal result', async () => {
    const invoke = vi.fn(async () => ({}));
    const client = new RemoteAgentRunClient(randomUUID(), {
      invoke, unregister() {},
    } as unknown as RemoteAgentPoller, {
      onEvent() {}, onState() {}, onWs() {}, onClosed() {},
      onRequest: async () => ({ type: 'callback', value: null }),
    }, randomUUID);
    const sending = client.call('send', ['small message']);
    const rejected = expect(sending).rejects.toThrow('REMOTE_AGENT_EXPIRED');
    client.abandon('fixture-close');
    await rejected;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(invoke).not.toHaveBeenCalled();
    expect(client.hasPendingWork).toBe(false);
  });
});

// Unit regression (2026-11-18): the startup payload went out one 64 KiB chunk per
// round trip; on a slow return path 26 chunks took 41s. The receiver stores chunks
// by (uploadId, index) since its first release, so chunks may overlap on the wire.
// Exercise the production open() entry with acknowledgements held back by the test.
describe('RemoteAgentRunClient pipelined upload', () => {
  type Held = { index: number; uploadId: string; resolve(): void; reject(error: unknown): void };
  function fixture(fail?: (index: number, attempt: number) => unknown) {
    const held: Held[] = [];
    const attempts = new Map<string, number>();
    const stored = new Map<string, Map<number, Buffer>>();
    const opened: Array<{ acknowledged: number; chunks: number; payload: unknown }> = [];
    let inFlight = 0, maxInFlight = 0;
    const acknowledged = new Map<string, number>();
    const invoke = async (args: unknown[]) => {
      const request = parseRemoteAgentRequest(args[0]);
      if (request.op === 'upload') {
        const key = `${request.uploadId}:${request.index}`;
        const attempt = attempts.get(key) ?? 0;
        attempts.set(key, attempt + 1);
        const error = fail?.(request.index, attempt);
        if (error) throw error;
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve, reject) => held.push({ index: request.index, uploadId: request.uploadId, resolve, reject }));
        inFlight--;
        const chunks = stored.get(request.uploadId) ?? new Map<number, Buffer>();
        chunks.set(request.index, Buffer.from(request.data, 'base64'));
        stored.set(request.uploadId, chunks);
        acknowledged.set(request.uploadId, (acknowledged.get(request.uploadId) ?? 0) + 1);
      } else if (request.op === 'open') {
        const reference = request.payload as { uploadId: string; chunks: number };
        const chunks = stored.get(reference.uploadId)!;
        opened.push({ acknowledged: acknowledged.get(reference.uploadId) ?? 0, chunks: reference.chunks,
          payload: JSON.parse(gunzipSync(Buffer.concat(Array.from({ length: reference.chunks }, (_, index) => chunks.get(index)!))).toString('utf8')) });
      }
      return {};
    };
    const poller = {
      invoke,
      register(run: { onData(data: Buffer, done: boolean): void }) {
        run.onData(Buffer.from(`${JSON.stringify({ t: 'started', handle: { id: 'pipelined' } })}\n`), false);
      },
      unregister() {},
    } as unknown as RemoteAgentPoller;
    const client = () => new RemoteAgentRunClient(randomUUID(), poller, {
      onEvent() {}, onState() {}, onWs() {}, onClosed() {},
      onRequest: async () => ({ type: 'callback', value: null }),
    }, randomUUID);
    /** Acknowledge held chunks oldest first until `done` settles. */
    const drain = async (done: Promise<unknown>) => {
      let settled = false;
      void done.then(() => { settled = true; }, () => { settled = true; });
      while (!settled) {
        await new Promise((resolve) => setImmediate(resolve));
        held.shift()?.resolve();
      }
    };
    return { client, drain, opened, attempts, maxInFlight: () => maxInFlight };
  }
  const input = () => ({ sessionId: 'pipelined-fixture', text: randomBytes(800 * 1024).toString('base64') });

  it('keeps several chunks in flight and opens only after every chunk is acknowledged', async () => {
    const { client, drain, opened, maxInFlight } = fixture();
    const value = input();
    const started = client().open('claude-code', value);
    await drain(started);
    await expect(started).resolves.toEqual({ id: 'pipelined' });
    expect(opened).toHaveLength(1);
    expect(opened[0].chunks).toBeGreaterThan(4);
    expect(opened[0].acknowledged).toBe(opened[0].chunks);
    expect(opened[0].payload).toEqual(value);
    expect(maxInFlight()).toBeGreaterThanOrEqual(2);
    expect(maxInFlight()).toBeLessThanOrEqual(4);
  });

  it('shares four upload slots among the runs of one computer', async () => {
    const { client, drain, opened, maxInFlight } = fixture();
    const both = Promise.all([client().open('claude-code', input()), client().open('codex', input())]);
    await drain(both);
    await both;
    expect(opened).toHaveLength(2);
    expect(maxInFlight()).toBe(4);
  });

  it('resends a chunk after a link error with the same index', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { client, drain, opened, attempts } = fixture((index, attempt) =>
      index === 1 && attempt === 0 ? Object.assign(new Error('peer busy'), { code: 'BACKPRESSURE' }) : undefined);
    const started = client().open('claude-code', input());
    const ticking = (async () => { while (opened.length === 0) await vi.advanceTimersByTimeAsync(100); })();
    await drain(started);
    await ticking;
    await expect(started).resolves.toEqual({ id: 'pipelined' });
    const [uploadId] = [...attempts.keys()][0].split(':');
    expect(attempts.get(`${uploadId}:1`)).toBe(2);
    expect(opened[0].acknowledged).toBe(opened[0].chunks);
  });

  it('stops sending chunks and never opens after a rejected chunk', async () => {
    const rejection = new Error('[REMOTE_AGENT_BUSY] too much staged data');
    const { client, drain, opened, attempts } = fixture((index) => index === 2 ? rejection : undefined);
    const started = client().open('claude-code', input());
    await drain(started);
    await expect(started).rejects.toThrow('too much staged data');
    expect(opened).toHaveLength(0);
    // Chunks 0–1 were in flight, 2 failed, at most one more had started before the failure surfaced.
    expect(Math.max(...[...attempts.keys()].map((key) => Number(key.split(':')[1])))).toBeLessThanOrEqual(3);
    expect(attempts.get([...attempts.keys()].find((key) => key.endsWith(':2'))!)).toBe(1);
  });
});

describe('RemoteAgentRunClient delivery', () => {
  // Unit, #11329: the old per-run timers replayed twenty locally unsent
  // deliveries together at 500/1500/3500ms. Real clients share one peer poller;
  // verify physical invoke admission, a separate peer and normal throughput.
  it('probes shared send pressure once per peer and drains original deliveries on recovery', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] }); vi.setSystemTime(0);
    const calls: Array<{ time: number; runId: string; seq: number }> = [];
    let active = 0, maxActive = 0;
    const invoke = async (args: unknown[]) => {
      const request = args[0] as { runId: string; seq: number };
      calls.push({ time: Date.now(), runId: request.runId, seq: request.seq });
      if (performance.now() < 3_500) throw Object.assign(new Error('local send queue full'), { code: 'BACKPRESSURE', inFlight: false });
      active++; maxActive = Math.max(maxActive, active);
      await new Promise<void>(resolve => setTimeout(resolve, 10)); // Fake transport acknowledgement.
      active--;
      return {};
    };
    const poller = new RemoteAgentPoller(invoke);
    const handlers = { onEvent() {}, onState() {}, onWs() {}, onClosed() {},
      onRequest: async () => ({ type: 'callback' as const, value: null }) };
    const clients = Array.from({ length: 20 }, (_, index) => new RemoteAgentRunClient(`run-${index}`, poller, handlers, randomUUID));
    const otherInvoke = vi.fn(async () => ({}));
    const other = new RemoteAgentRunClient('other-peer', new RemoteAgentPoller(otherInvoke), handlers, randomUUID);
    const frames = [{ connId: 'connection', kind: 'message' as const, data: 'frame' }];
    const deliveries = clients.map(client => client.push(frames));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(20);
      await vi.advanceTimersByTimeAsync(500);
      expect(calls).toHaveLength(21);
      await other.push(frames);
      expect(otherInvoke).toHaveBeenCalledOnce();
      vi.setSystemTime(-60_000); // Wall-clock correction must not extend the pressure cooldown.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toHaveLength(22);
      await vi.advanceTimersByTimeAsync(3_000);
      await Promise.all(deliveries);
      expect(calls).toHaveLength(42);
      expect(maxActive).toBe(1);
      expect(new Set(calls.map(call => call.runId)).size).toBe(20);
      expect(calls.every(call => call.seq === 1)).toBe(true);
      // Once the pressured backlog drains, normal first sends remain concurrent.
      const normal = clients.map(client => client.push(frames));
      expect(active).toBe(20);
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all(normal);
    } finally {
      clients.forEach(client => client.abandon('fixture-complete')); other.abandon('fixture-complete');
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.allSettled(deliveries);
    }
  });

  // Unit, #11329: cancelling a reverse request after its handler completed,
  // or closing a run while it waits for peer capacity, must cancel admission.
  it.each(['cancel-reply', 'close-push'] as const)('removes queued delivery after %s', async mode => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    const invoke = vi.fn(async () => { throw Object.assign(new Error('send queue full'), { code: 'BACKPRESSURE', inFlight: false }); });
    const onRequest = vi.fn(async () => ({ type: 'callback' as const, value: 'answer' }));
    const client = new RemoteAgentRunClient('run', new RemoteAgentPoller(invoke), {
      onEvent() {}, onState() {}, onWs() {}, onClosed() {}, onRequest,
    }, randomUUID);
    const requestId = '11111111-2222-4333-8444-555555555555';
    const delivery = mode === 'close-push'
      ? client.push([{ connId: 'connection', kind: 'message', data: 'frame' }])
      : (client.onData(Buffer.from(`${JSON.stringify({ t: 'request', requestId,
        request: { type: 'callback', name: 'onTranscriptUserEntry', args: ['call', 'entry'] } })}\n`), false), Promise.resolve());
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledOnce();
    if (mode === 'close-push') client.abandon('account-boundary');
    else client.onData(Buffer.from(`${JSON.stringify({ t: 'cancel', requestId })}\n`), false);
    await vi.advanceTimersByTimeAsync(5_000);
    await delivery;
    expect(invoke).toHaveBeenCalledOnce();
    expect(client.hasPendingWork).toBe(false);
    client.abandon('fixture-complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  // Unit, #11329: shared admission is not shared cancellation. A cancelled
  // tool reply must leave a neighbour's original push queued for the next probe.
  it('shares reply and push pressure while cancelling only the requesting run', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    const invoke = vi.fn(async (_args: unknown[]) => ({})).mockRejectedValueOnce(Object.assign(new Error('send queue full'), { code: 'BACKPRESSURE' }));
    const poller = new RemoteAgentPoller(invoke);
    const handlers = { onEvent() {}, onState() {}, onWs() {}, onClosed() {},
      onRequest: async () => ({ type: 'callback' as const, value: 'answer' }) };
    const reply = new RemoteAgentRunClient('reply', poller, handlers, randomUUID);
    const push = new RemoteAgentRunClient('push', poller, handlers, randomUUID);
    const requestId = '11111111-2222-4333-8444-555555555555';
    reply.onData(Buffer.from(`${JSON.stringify({ t: 'request', requestId,
      request: { type: 'callback', name: 'onTranscriptUserEntry', args: ['call', 'entry'] } })}\n`), false);
    await vi.advanceTimersByTimeAsync(0);
    const sending = push.push([{ connId: 'connection', kind: 'message', data: 'frame' }]);
    expect(invoke).toHaveBeenCalledOnce();
    reply.onData(Buffer.from(`${JSON.stringify({ t: 'cancel', requestId })}\n`), false);
    await vi.advanceTimersByTimeAsync(500);
    await sending;
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][0]).toMatchObject([{ op: 'push', runId: 'push', seq: 1 }]);
    expect(reply.hasPendingWork).toBe(false);
    reply.abandon('fixture-complete'); push.abandon('fixture-complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  // Unit, #11329: gate waiting never fabricates attempts or defeats the
  // existing delivery ceiling; persistent pressure still terminates at 30.
  it('retains the bounded delivery attempt budget under persistent peer pressure', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    const invoke = vi.fn(async () => { throw Object.assign(new Error('send queue full'), { code: 'BACKPRESSURE' }); });
    const client = new RemoteAgentRunClient('bounded', new RemoteAgentPoller(invoke), {
      onEvent() {}, onState() {}, onWs() {}, onClosed() {},
      onRequest: async () => ({ type: 'callback', value: null }),
    }, randomUUID);
    const failed = expect(client.push([{ connId: 'connection', kind: 'message', data: 'frame' }])).rejects.toMatchObject({ code: 'BACKPRESSURE' });
    await vi.advanceTimersByTimeAsync(200_000);
    await failed;
    expect(invoke).toHaveBeenCalledTimes(30);
    expect(client.hasPendingWork).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    client.abandon('fixture-complete');
  });

  // Unit regression: the shared retry classifier also protects idempotent replies.
  // The existing timeout fixture did not cover a circuit-open rejection with Error.code.
  it.each(['TIMEOUT', 'DEVICE_UNRESPONSIVE', 'BACKPRESSURE'])('retries a reply after %s without repeating the request handler', async code => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    const replyAttempts: number[] = [];
    const replyPayloads: unknown[] = [];
    let failuresLeft = 2;
    const invoke = async (args: unknown[]): Promise<unknown> => {
      const op = (args[0] as { op: string }).op;
      if (op === 'reply') {
        replyAttempts.push(replyAttempts.length + 1);
        replyPayloads.push((args[0] as { payload: unknown }).payload);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw code === 'DEVICE_UNRESPONSIVE'
            ? remoteAgentLinkError(createDeviceUnresponsiveError('host'))
            : code === 'BACKPRESSURE'
              ? remoteAgentLinkError(Object.assign(new Error('send queue full'), { code, inFlight: false }))
              : new Error('TIMEOUT: link dropped mid-reply');
        }
      }
      return {};
    };
    const onRequest = vi.fn(async () => ({ type: 'interaction' as const, result: { kind: 'permission' as const, behavior: 'allow' as const } }));
    const client = new RemoteAgentRunClient(
      'run-1',
      { invoke, unregister: () => undefined } as unknown as RemoteAgentPoller,
      {
        onEvent: () => undefined,
        onState: () => undefined,
        onWs: () => undefined,
        onClosed: () => undefined,
        onRequest,
      },
      () => 'generated-id',
    );
    client.onData(Buffer.from(`${JSON.stringify({
      t: 'request',
      requestId: '11111111-2222-4333-8444-555555555555',
      request: {
        type: 'interaction',
        request: { kind: 'permission', requestId: 'r1', toolName: 'bash', input: { command: 'echo hi' } },
      },
    })}\n`), false);
    // 两次链路失败(退避 500ms / 1000ms)后第三次交付成功。
    await vi.advanceTimersByTimeAsync(1_500);
    expect(replyAttempts).toHaveLength(3);
    expect(failuresLeft).toBe(0);
    // 重试复用同一份载荷(同一引用)：重建载荷会在对方 staging 里多留一份无人消费的上传。
    expect(new Set(replyPayloads).size).toBe(1);
    expect(onRequest).toHaveBeenCalledOnce();
  });

  it('reuses one uploaded payload when retrying a large reply', async () => {
    const uploadIds = new Set<string>();
    const replyUploadIds: Array<string | undefined> = [];
    let failuresLeft = 1;
    const invoke = async (args: unknown[]): Promise<unknown> => {
      const op = args[0] as { op: string; uploadId?: string; payload?: { uploadId?: string } };
      if (op.op === 'upload' && op.uploadId) uploadIds.add(op.uploadId);
      if (op.op === 'reply') {
        replyUploadIds.push(op.payload?.uploadId);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('TIMEOUT: link dropped mid-reply');
        }
      }
      return {};
    };
    let seq = 0;
    const client = new RemoteAgentRunClient(
      'run-1',
      { invoke, unregister: () => undefined } as unknown as RemoteAgentPoller,
      {
        onEvent: () => undefined,
        onState: () => undefined,
        onWs: () => undefined,
        onClosed: () => undefined,
        // 大回包(超过内联上限)走分段上传。
        onRequest: async () => ({ type: 'callback', value: 'x'.repeat(2 * 1024 * 1024) }),
      },
      () => `generated-${(seq += 1)}`,
    );
    client.onData(Buffer.from(`${JSON.stringify({
      t: 'request',
      requestId: '11111111-2222-4333-8444-555555555555',
      request: { type: 'callback', name: 'onTranscriptUserEntry', args: ['call-1', 'entry-1'] },
    })}\n`), false);
    const deadline = Date.now() + 10_000;
    while (replyUploadIds.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 重试复用同一份上传载荷(同一个 uploadId)：每次都造新 upload 会把载荷留在对方
    // 暂存区直到过期，反复歧义交付会占满配额、挡住无关上传。
    expect(replyUploadIds).toHaveLength(2);
    expect(new Set(replyUploadIds).size).toBe(1);
    expect(replyUploadIds[0]).toBeDefined();
    expect(uploadIds.size).toBe(1);
  });

  // Unit: circuit recovery must resend the original batch sequence, not create
  // a new push. Reply tests cannot detect duplicate delivery of pushed frames.
  it('retries a circuit-blocked push with its original sequence and frames', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => ({}))
      .mockRejectedValueOnce(remoteAgentLinkError(createDeviceUnresponsiveError('host')));
    const client = new RemoteAgentRunClient(
      'run-1',
      { invoke, unregister: () => undefined } as unknown as RemoteAgentPoller,
      {
        onEvent: () => undefined, onState: () => undefined,
        onWs: () => undefined, onClosed: () => undefined,
        onRequest: async () => ({ type: 'callback', value: null }),
      },
      () => 'generated-id',
    );
    const frames = [{ connId: 'connection', kind: 'message' as const, data: 'frame' }];
    const delivered = expect(client.push(frames)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    await delivered;
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, [{ op: 'push', runId: 'run-1', seq: 1, frames }]);
    expect(invoke).toHaveBeenNthCalledWith(2, [{ op: 'push', runId: 'run-1', seq: 1, frames }]);
  });
});
