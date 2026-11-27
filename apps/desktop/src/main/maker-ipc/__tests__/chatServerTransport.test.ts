import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { isReady: () => true }, net: { fetch: vi.fn() } }));
import {
  isTransientGetTransportReset,
  normalizeNetFetchError,
  performChatHttpRequest,
} from '../chatServerTransport.js';

describe('chatServerTransport', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('uses fetchImpl with manual redirect and returns status, headers and body', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
    }));
    const res = await performChatHttpRequest({
      url: new URL('https://chat.cindy.app/v1/me'),
      method: 'GET',
      headers: { Authorization: 'Bearer tok', 'X-Chat-Desktop': '1' },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://chat.cindy.app/v1/me',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        headers: { Authorization: 'Bearer tok', 'X-Chat-Desktop': '1' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ ok: true });
  });

  it.each([
    ['302 status', new Response(null, { status: 302, headers: { Location: 'https://evil.test' } })],
    ['opaqueredirect', { type: 'opaqueredirect', status: 0, headers: new Headers(), body: null } as unknown as Response],
  ])('refuses redirects (%s) with CHAT_REDIRECT_REFUSED', async (_label, response) => {
    const fetchImpl = vi.fn(async () => response);
    await expect(performChatHttpRequest({
      url: new URL('https://chat.cindy.app/v1/me'),
      method: 'GET',
      headers: {},
      fetchImpl,
    })).rejects.toThrow('CHAT_REDIRECT_REFUSED');
  });

  it('aborts and rejects with RESPONSE_TOO_LARGE when streamed body exceeds maxBytes', async () => {
    let aborted = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return new Response(stream, { status: 200 });
    });
    await expect(performChatHttpRequest({
      url: new URL('https://chat.cindy.app/v1/me'),
      method: 'GET',
      headers: {},
      maxBytes: 100,
      fetchImpl,
    })).rejects.toThrow('RESPONSE_TOO_LARGE');
    expect(aborted).toBe(true);
  });

  it('enforces REQUEST_TIMEOUT even when fetchImpl ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const pending = performChatHttpRequest({
      url: new URL('https://chat.cindy.app/v1/me'),
      method: 'GET',
      headers: {},
      timeoutMs: 250,
      fetchImpl,
    });
    const caught = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(250);
    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('REQUEST_TIMEOUT');
  });

  it('cancels late response bodies and suppresses late rejections after REQUEST_TIMEOUT', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let rejectLate!: (error: Error) => void;
      const lateRejectFetch = vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectLate = reject; }));
      const p1 = performChatHttpRequest({
        url: new URL('https://chat.cindy.app/v1/me'),
        method: 'GET',
        headers: {},
        timeoutMs: 100,
        fetchImpl: lateRejectFetch,
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect((await p1 as Error).message).toBe('REQUEST_TIMEOUT');
      rejectLate(new Error('late network abort'));
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);

      let resolveLate!: (res: Response) => void;
      const cancel = vi.fn(async () => undefined);
      const lateResolveFetch = vi.fn(() => new Promise<Response>((resolve) => { resolveLate = resolve; }));
      const p2 = performChatHttpRequest({
        url: new URL('https://chat.cindy.app/v1/me'),
        method: 'GET',
        headers: {},
        timeoutMs: 100,
        fetchImpl: lateResolveFetch,
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect((await p2 as Error).message).toBe('REQUEST_TIMEOUT');
      resolveLate({ status: 200, type: 'basic', headers: new Headers(), body: { cancel } } as unknown as Response);
      await Promise.resolve();
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledOnce();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('normalizes Chromium net::ERR_* errors and classifies transient GET resets', () => {
    const netReset = normalizeNetFetchError(new Error('net::ERR_CONNECTION_RESET'), false);
    expect((netReset as { code?: string }).code).toBe('ERR_CONNECTION_RESET');
    expect(isTransientGetTransportReset(netReset)).toBe(true);

    const h2Reset = normalizeNetFetchError(new Error('net::ERR_HTTP2_PROTOCOL_ERROR'), false);
    expect((h2Reset as { code?: string }).code).toBe('ERR_HTTP2_PROTOCOL_ERROR');
    expect(isTransientGetTransportReset(h2Reset)).toBe(true);

    expect(isTransientGetTransportReset(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientGetTransportReset(new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }))).toBe(true);

    // Non-reset errors must never be auto-retried as transport resets.
    expect(isTransientGetTransportReset(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))).toBe(false);
    expect(isTransientGetTransportReset(new Error('REQUEST_TIMEOUT'))).toBe(false);
    expect(isTransientGetTransportReset(new Error('CHAT_REDIRECT_REFUSED'))).toBe(false);
    expect(isTransientGetTransportReset(Object.assign(new Error('server error'), { status: 500, code: 'ECONNRESET' }))).toBe(false);
  });
});
