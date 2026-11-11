/**
 * 反向请求回包交付：链路抖动导致 reply 发送失败时必须重试——对方一直在等同一
 * requestId 的回包，只记日志不重试会让任务停在权限确认 / 工具请求上无法推进。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseRemoteAgentRequest, type RemoteAgentPayload } from '@cindy/device-link';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeviceUnresponsiveError } from '../../device-link/responsivenessTracker';
import type { RemoteAgentPoller } from '../controller/poller';
import { remoteAgentLinkError, RemoteAgentRunClient } from '../controller/runClient';

afterEach(() => vi.useRealTimers());

// Unit regression: the production open/payload entry must deliver over a slow
// relay without a single upload/inline request outliving its 30s deadline.
// Reply-retry coverage did not exercise byte-paced delivery or old receivers'
// chunk-count ceiling. The link below models 16 KiB/s + 1s RTT without waiting;
// gzip, request parsing and complete payload reconstruction remain real.
describe('RemoteAgentRunClient slow payload delivery', () => {
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

describe('RemoteAgentRunClient delivery', () => {
  // Unit regression: the shared retry classifier also protects idempotent replies.
  // The existing timeout fixture did not cover a circuit-open rejection with Error.code.
  it.each(['TIMEOUT', 'DEVICE_UNRESPONSIVE'])('retries a reply after %s without repeating the request handler', async code => {
    vi.useFakeTimers();
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
