import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StreamModerationClient,
  type StreamModerationCallbacks,
} from '../streamClient.js';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createHarness() {
  let sseController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const inputBodies: string[] = [];
  const encoder = new TextEncoder();
  const events = new ReadableStream<Uint8Array>({
    start(controller) {
      sseController = controller;
    },
  });
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/api/moderation/sign/json')) {
      return json({
        gateway_base_url: 'https://gateway.example.invalid',
        logical_path: '/api/v1/review/stream/tasks',
        headers: {
          Authorization: 'signed',
          'X-Timestamp': '1700000000',
          'X-Nonce': 'nonce',
          'Content-Type': 'application/json',
        },
      }, 200);
    }
    if (target.endsWith('/api/v1/review/stream/tasks') && init?.method === 'POST') {
      return json({
        code: 200,
        data: {
          task_id: 'task-1',
          write_token: 'write-token',
          read_token: 'read-token',
        },
      }, 201);
    }
    if (target.endsWith('/events')) {
      return new Response(events, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    if (target.endsWith('/input')) {
      const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let body = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
      }
      inputBodies.push(body);
      const nextSequence = body.trim()
        ? body.trim().split('\n').length
        : 0;
      return json({ code: 200, data: { accepted: true, next_sequence: nextSequence } }, 200);
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
  return {
    fetchMock,
    inputBodies,
    emit(event: string, data: unknown, id: string): void {
      sseController?.enqueue(encoder.encode(
        `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      ));
    },
    emitRaw(value: string): void {
      sseController?.enqueue(encoder.encode(value));
    },
    closeEvents(): void {
      sseController?.close();
    },
  };
}

const createInput = {
  signBaseUrl: 'https://sign.example.invalid',
  accessToken: 'access-token',
  membershipId: 'member-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
};

function callbacks() {
  return {
    onRelease: vi.fn(),
    onBlock: vi.fn(),
    onFailed: vi.fn(),
    onCompleted: vi.fn(),
    onFailOpen: vi.fn(),
  } satisfies StreamModerationCallbacks;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('StreamModerationClient completion safety', () => {
  it('task.completed 作为整项通过终态，按 sequence 释放剩余缓冲', async () => {
    const harness = createHarness();
    const cb = callbacks();
    const client = await StreamModerationClient.create(
      createInput,
      cb,
      harness.fetchMock as typeof fetch,
    );
    client?.push('raw');
    client?.finish();
    harness.emit('task.completed', {}, 'completed');
    await vi.waitFor(() => expect(cb.onCompleted).toHaveBeenCalledTimes(1));
    expect(cb.onRelease).toHaveBeenCalledWith({ sequence: 0, text: 'raw' });
    expect(cb.onFailOpen).not.toHaveBeenCalled();
    harness.closeEvents();
  });

  it('task.completed 前已收到的安全 release 不会被原文覆盖', async () => {
    const harness = createHarness();
    const cb = callbacks();
    const client = await StreamModerationClient.create(
      createInput,
      cb,
      harness.fetchMock as typeof fetch,
    );
    client?.push('raw');
    client?.finish();
    harness.emit('content.release', { sequence: 0, text: 'safe' }, 'release');
    harness.emit('task.completed', {}, 'completed');

    await vi.waitFor(() => expect(cb.onCompleted).toHaveBeenCalledTimes(1));
    expect(cb.onRelease).toHaveBeenCalledWith({ sequence: 0, text: 'safe' });
    expect(cb.onFailOpen).not.toHaveBeenCalled();
    harness.closeEvents();
  });

  it('接受 final 空 frame 的 release，仅用它推进顺序而不下发正文', async () => {
    const harness = createHarness();
    const cb = callbacks();
    const client = await StreamModerationClient.create(
      createInput,
      cb,
      harness.fetchMock as typeof fetch,
    );
    client?.push('raw');
    client?.finish();

    // The real gateway may release the final frame before an earlier text
    // frame reaches the SSE consumer, so both ordering and invisibility matter.
    harness.emit('content.release', { sequence: 1, text: '' }, 'final-release');
    await Promise.resolve();
    expect(cb.onRelease).not.toHaveBeenCalled();
    expect(cb.onFailOpen).not.toHaveBeenCalled();

    harness.emit('content.release', { sequence: 0, text: 'safe' }, 'text-release');
    harness.emit('task.completed', {}, 'completed');

    await vi.waitFor(() => expect(cb.onCompleted).toHaveBeenCalledTimes(1));
    expect(cb.onRelease).toHaveBeenCalledTimes(1);
    expect(cb.onRelease).toHaveBeenCalledWith({ sequence: 0, text: 'safe' });
    expect(cb.onFailOpen).not.toHaveBeenCalled();
    harness.closeEvents();
  });

  it('拒绝携带正文的 final release 并安全 fail-open', async () => {
    const harness = createHarness();
    const cb = callbacks();
    const client = await StreamModerationClient.create(
      createInput,
      cb,
      harness.fetchMock as typeof fetch,
    );
    client?.push('raw');
    client?.finish();
    harness.emit('content.release', { sequence: 1, text: 'unexpected' }, 'bad-final');

    await vi.waitFor(() => expect(cb.onFailOpen).toHaveBeenCalledTimes(1));
    expect(cb.onRelease).toHaveBeenCalledTimes(1);
    expect(cb.onRelease).toHaveBeenCalledWith({ sequence: 0, text: 'raw' });
    harness.closeEvents();
  });

  it('finish 幂等，且 final 后拒绝继续 push', async () => {
    const harness = createHarness();
    const cb = callbacks();
    const client = await StreamModerationClient.create(
      createInput,
      cb,
      harness.fetchMock as typeof fetch,
    );
    expect(client?.push('before')).toBe(0);
    client?.finish();
    client?.finish();
    expect(client?.push('after')).toBe(-1);

    await vi.waitFor(() => expect(harness.inputBodies).toHaveLength(1));
    expect(harness.inputBodies[0]?.trim().split('\n')).toHaveLength(2);
    client?.cancel();
    harness.closeEvents();
  });

  it('可解析跨网络 chunk 拆分的 CRLF', async () => {
    const harness = createHarness();
    const cb = callbacks();
    const client = await StreamModerationClient.create(
      createInput,
      cb,
      harness.fetchMock as typeof fetch,
    );
    client?.push('raw');
    harness.emitRaw('id: 1\r\nevent: content.release\r\ndata: {"sequence":0,"text":"safe"}\r');
    harness.emitRaw('\n\r\n');

    await vi.waitFor(() => expect(cb.onRelease).toHaveBeenCalledWith({
      sequence: 0,
      text: 'safe',
    }));
    client?.cancel();
    harness.closeEvents();
  });
});

describe('StreamModerationClient', () => {
  it('SSE 先建立，release 去重并按 sequence 连续释放', async () => {
    const harness = createHarness();
    const cb = callbacks();
    const client = await StreamModerationClient.create(
      createInput,
      cb,
      harness.fetchMock as typeof fetch,
    );
    expect(client).not.toBeNull();
    expect(String(harness.fetchMock.mock.calls[2]?.[0])).toContain('/events');

    client?.push('a');
    client?.push('b');
    harness.emit('content.release', { sequence: 1, text: 'B' }, '2');
    await Promise.resolve();
    expect(cb.onRelease).not.toHaveBeenCalled();

    harness.emit('content.release', { sequence: 0, text: 'A' }, '1');
    harness.emit('content.release', { sequence: 0, text: 'A' }, '1-duplicate');
    await vi.waitFor(() => expect(cb.onRelease).toHaveBeenCalledTimes(2));
    expect(cb.onRelease.mock.calls.map(([frame]) => frame)).toEqual([
      { sequence: 0, text: 'A' },
      { sequence: 1, text: 'B' },
    ]);

    client?.finish();
    await vi.waitFor(() => expect(harness.inputBodies).toHaveLength(1));
    expect(harness.inputBodies[0]?.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { sequence: 0, text: 'a', is_final: false },
      { sequence: 1, text: 'b', is_final: false },
      { sequence: 2, text: '', is_final: true },
    ]);
    client?.cancel();
    harness.closeEvents();
  });

  it('最老未 release frame 等待 5 秒后 fail-open，并忽略迟到 block', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const cb = callbacks();
    const client = await StreamModerationClient.create(
      createInput,
      cb,
      harness.fetchMock as typeof fetch,
    );
    client?.push('raw');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(cb.onRelease).toHaveBeenCalledWith({ sequence: 0, text: 'raw' });
    expect(cb.onFailOpen).toHaveBeenCalledTimes(1);

    harness.emit('content.block', { audited_through: 0 }, 'late');
    await Promise.resolve();
    expect(cb.onBlock).not.toHaveBeenCalled();
    harness.closeEvents();
  });

  it('首段 release 后为后续最老待审 frame 重新启动 5 秒 watchdog', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const cb = callbacks();
    const client = await StreamModerationClient.create(
      createInput,
      cb,
      harness.fetchMock as typeof fetch,
    );
    client?.push('first');
    await vi.advanceTimersByTimeAsync(4_000);
    harness.emit('content.release', { sequence: 0, text: 'first-safe' }, '1');
    await Promise.resolve();
    client?.push('second');

    await vi.advanceTimersByTimeAsync(4_999);
    expect(cb.onFailOpen).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cb.onFailOpen).toHaveBeenCalledTimes(1);
    expect(cb.onRelease).toHaveBeenLastCalledWith({ sequence: 1, text: 'second' });
    harness.closeEvents();
  });
});
