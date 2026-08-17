import { EventEmitter } from 'node:events';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import { createAnthropicCompatProxy } from '@cindy/anthropic-compat-proxy';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cindy-pi-native-forwarding-test' },
}));

vi.mock('../logger-adapter.js', () => ({
  createMakerLogger: () => {
    const make = (): Record<string, unknown> => ({
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      child: vi.fn(() => make()),
    });
    return make();
  },
  desktopMakerLogger: {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => ({
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      child: vi.fn(),
    })),
  },
}));

import {
  getPiNativeSubscriptionHandler,
  type PiNativeSubscriptionHandlerDeps,
} from '../anthropic-responses-bridge-host.js';

function responseRecorder() {
  const response = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    headersSent: boolean;
    status: number;
    headers: Record<string, string>;
    chunks: Buffer[];
    writeHead: (status: number, headers?: Record<string, string>) => void;
    write: (chunk: Uint8Array | string) => boolean;
    end: (chunk?: Uint8Array | string) => void;
  };
  response.destroyed = false;
  response.headersSent = false;
  response.status = 0;
  response.headers = {};
  response.chunks = [];
  response.writeHead = (status, headers = {}) => {
    response.status = status;
    response.headers = headers;
    response.headersSent = true;
  };
  response.write = (chunk) => {
    response.chunks.push(Buffer.from(chunk));
    return true;
  };
  response.end = (chunk) => {
    if (chunk !== undefined) response.chunks.push(Buffer.from(chunk));
  };
  return response;
}

function deps(overrides: Partial<PiNativeSubscriptionHandlerDeps> = {}): PiNativeSubscriptionHandlerDeps {
  return {
    fetch: vi.fn(async () => new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as PiNativeSubscriptionHandlerDeps['fetch'],
    getChatgptAuth: vi.fn(async () => ({ accessToken: 'host-openai-token', accountId: 'account-1' })),
    getGrokToken: vi.fn(async () => 'host-xai-token'),
    invalidateChatgpt: vi.fn(async () => false),
    invalidateXai: vi.fn(async () => 'ignored' as const),
    recordXaiRateLimit: vi.fn(),
    ...overrides,
  };
}

describe('PI native subscription forwarding', () => {
  it('forwards Codex Responses bytes unchanged with host-owned ChatGPT auth', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('event: done\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const injected = deps({ fetch: fetchMock as PiNativeSubscriptionHandlerDeps['fetch'] });
    const handler = getPiNativeSubscriptionHandler('openai', 'session-1', injected);
    const rawBody = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]);
    const res = responseRecorder();

    await handler({
      rawBody,
      parsedBody: undefined,
      ctx: {
        reqId: 1,
        method: 'POST',
        url: '/codex/responses',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'zstd',
          authorization: 'Bearer placeholder-that-must-not-leak',
        },
      },
      res,
    } as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer host-openai-token',
      'chatgpt-account-id': 'account-1',
      'content-encoding': 'zstd',
      'content-type': 'application/json',
    });
    expect(Buffer.from(init?.body as Uint8Array)).toEqual(rawBody);
    expect(JSON.stringify(init?.headers)).not.toContain('placeholder-that-must-not-leak');
    expect(res.status).toBe(200);
    expect(Buffer.concat(res.chunks).toString('utf8')).toContain('event: done');
  });

  it('keeps Pi 1M as a distinct local model but sends the official bare id upstream', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('event: done\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const handler = getPiNativeSubscriptionHandler('openai', 'session-1m', deps({
      fetch: fetchMock as PiNativeSubscriptionHandlerDeps['fetch'],
    }));
    const parsedBody = { model: 'gpt-5.6-sol[1m]', input: 'hello' };

    await handler({
      rawBody: Buffer.from(JSON.stringify(parsedBody)),
      parsedBody,
      ctx: {
        reqId: 2,
        method: 'POST',
        url: '/codex/responses',
        headers: { 'content-type': 'application/json' },
      },
      res: responseRecorder(),
    } as never);

    const request = JSON.parse(
      Buffer.from(fetchMock.mock.calls[0]![1]?.body as Uint8Array).toString('utf8'),
    );
    expect(request).toEqual({ model: 'gpt-5.6-sol', input: 'hello' });
    expect(fetchMock.mock.calls[0]![1]?.headers).not.toHaveProperty('content-encoding');
  });

  it('rewrites the profile suffix after the real proxy zstd parse boundary', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('event: done\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const handler = getPiNativeSubscriptionHandler('openai', 'session-1m-zstd', deps({
      fetch: fetchMock as PiNativeSubscriptionHandlerDeps['fetch'],
    }));
    const proxy = await createAnthropicCompatProxy({
      upstream: null,
      transformRequest: [],
      routingTransform: () => ({ localHandler: handler }),
    });
    const compressed = zstdCompressSync(Buffer.from(JSON.stringify({
      model: 'gpt-5.6-sol[1m]',
      input: 'hello',
    })));

    try {
      const response = await fetch(`${proxy.url}/codex/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
        body: compressed,
      });
      expect(response.status).toBe(200);
      await response.text();
    } finally {
      await proxy.dispose();
    }

    const init = fetchMock.mock.calls[0]![1];
    expect(init?.headers).toMatchObject({ 'content-encoding': 'zstd' });
    const request = JSON.parse(
      zstdDecompressSync(Buffer.from(init?.body as Uint8Array)).toString('utf8'),
    );
    expect(request).toEqual({ model: 'gpt-5.6-sol', input: 'hello' });
  });

  it('destroys the local bridge response when a native upstream stream fails after headers', async () => {
    const upstreamError = new Error('native upstream disconnected mid-stream');
    let sentFirstChunk = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentFirstChunk) {
          sentFirstChunk = true;
          controller.enqueue(Buffer.from('event: response.output_text.delta\ndata: {"delta":"partial"}\n\n'));
          return;
        }
        controller.error(upstreamError);
      },
    });
    const handler = getPiNativeSubscriptionHandler('openai', 'session-stream-error', deps({
      fetch: vi.fn(async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as PiNativeSubscriptionHandlerDeps['fetch'],
    }));
    const proxy = await createAnthropicCompatProxy({
      upstream: null,
      transformRequest: [],
      routingTransform: () => ({ localHandler: handler }),
    });

    try {
      await expect((async () => {
        const response = await fetch(`${proxy.url}/codex/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        await response.text();
      })()).rejects.toThrow();
    } finally {
      await proxy.dispose();
    }
  });

  it('adds model-gated x_search to native general Grok requests after PI function tools', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('event: done\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const handler = getPiNativeSubscriptionHandler('xai', 'session-x-search', deps({
      fetch: fetchMock as PiNativeSubscriptionHandlerDeps['fetch'],
    }));
    const parsedBody = {
      model: 'grok-4.5',
      tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
      tool_choice: 'required',
    };

    await handler({
      rawBody: Buffer.from(JSON.stringify(parsedBody)),
      parsedBody,
      ctx: {
        reqId: 5,
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
      },
      res: responseRecorder(),
    } as never);

    const request = JSON.parse(Buffer.from(fetchMock.mock.calls[0]![1]?.body as Uint8Array).toString('utf8'));
    expect(request.tools).toEqual([
      { type: 'function', name: 'read_file', parameters: { type: 'object' } },
      { type: 'x_search' },
    ]);
    expect(request.tool_choice).toEqual({ type: 'function', name: 'read_file' });
  });

  it('preserves an existing native x_search declaration without duplicating it', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('event: done\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const handler = getPiNativeSubscriptionHandler('xai', 'session-x-search-existing', deps({
      fetch: fetchMock as PiNativeSubscriptionHandlerDeps['fetch'],
    }));
    const parsedBody = {
      model: 'grok-4.5',
      tools: [{ type: 'x_search', from_date: '2026-08-01' }],
    };
    const rawBody = Buffer.from(JSON.stringify(parsedBody));

    await handler({
      rawBody,
      parsedBody,
      ctx: {
        reqId: 6,
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
      },
      res: responseRecorder(),
    } as never);

    const forwarded = Buffer.from(fetchMock.mock.calls[0]![1]?.body as Uint8Array);
    expect(forwarded).toEqual(rawBody);
    expect(JSON.parse(forwarded.toString('utf8')).tools).toEqual([
      { type: 'x_search', from_date: '2026-08-01' },
    ]);
  });

  it.each(['grok-code-fast', 'grok-build-0.1'])(
    'does not add x_search to native coding model %s',
    async (model) => {
      const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('event: done\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
      const handler = getPiNativeSubscriptionHandler('xai', `session-${model}`, deps({
        fetch: fetchMock as PiNativeSubscriptionHandlerDeps['fetch'],
      }));
      const parsedBody = { model };
      const rawBody = Buffer.from(JSON.stringify(parsedBody));

      await handler({
        rawBody,
        parsedBody,
        ctx: {
          reqId: 7,
          method: 'POST',
          url: '/v1/responses',
          headers: { 'content-type': 'application/json' },
        },
        res: responseRecorder(),
      } as never);

      expect(Buffer.from(fetchMock.mock.calls[0]![1]?.body as Uint8Array)).toEqual(rawBody);
    },
  );

  it('forwards xAI Chat Completions natively and invalidates the failed host token', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{"error":"expired"}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }));
    const invalidateXai = vi.fn(async () => 'ignored' as const);
    const injected = deps({
      fetch: fetchMock as PiNativeSubscriptionHandlerDeps['fetch'],
      invalidateXai,
    });
    const handler = getPiNativeSubscriptionHandler('xai', 'session-2', injected);
    const rawBody = Buffer.from('{"model":"grok-build-0.1"}');
    const res = responseRecorder();

    await handler({
      rawBody,
      parsedBody: undefined,
      ctx: {
        reqId: 2,
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
      },
      res,
    } as never);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.x.ai/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer host-xai-token' }),
      }),
    );
    expect(invalidateXai).toHaveBeenCalledWith(expect.objectContaining({
      status: 401,
      failedAccessToken: 'host-xai-token',
    }));
    expect(res.status).toBe(401);
    expect(Buffer.concat(res.chunks).toString('utf8')).toContain('expired');
  });

  it('records only xAI rate-limit headers that are actually present', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('event: done\n\n', {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-ratelimit-remaining-requests': '9',
        },
      }));
    const recordXaiRateLimit = vi.fn();
    const injected = deps({
      fetch: fetchMock as PiNativeSubscriptionHandlerDeps['fetch'],
      recordXaiRateLimit,
    });
    const handler = getPiNativeSubscriptionHandler('xai', 'session-rate', injected);
    const res = responseRecorder();

    await handler({
      rawBody: Buffer.from('{}'),
      parsedBody: {},
      ctx: {
        reqId: 4,
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
      },
      res,
    } as never);

    expect(recordXaiRateLimit).toHaveBeenCalledWith({
      limitRequests: undefined,
      remainingRequests: 9,
      limitTokens: undefined,
      remainingTokens: undefined,
    });
  });

  it('rejects unsupported native paths without contacting an upstream', async () => {
    const injected = deps();
    const handler = getPiNativeSubscriptionHandler('openai', 'session-3', injected);
    const res = responseRecorder();

    await handler({
      rawBody: Buffer.alloc(0),
      parsedBody: undefined,
      ctx: { reqId: 3, method: 'GET', url: '/models', headers: {} },
      res,
    } as never);

    expect(injected.fetch).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
  });
});
