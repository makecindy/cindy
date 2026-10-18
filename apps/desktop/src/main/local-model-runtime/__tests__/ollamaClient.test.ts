import http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyOllamaPullError } from '../../../shared/localModelRuntime.js';

import { fetchOllamaVersion, OllamaHttpError, streamOllamaPull } from '../ollamaClient.js';

describe('fetchOllamaVersion', () => {
  it('accepts a version JSON body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ version: '0.32.13' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(fetchOllamaVersion(fetchImpl)).resolves.toEqual({ version: '0.32.13' });
  });

  it('treats a non-Ollama HTTP body as a port conflict', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>not ollama</html>', { status: 200 }));
    await expect(fetchOllamaVersion(fetchImpl)).rejects.toMatchObject({
      kind: 'conflict',
    } satisfies Partial<OllamaHttpError>);
  });
});

// #6311 / maintainer6230690779 explicitly requires real pull-entry regressions.
// Existing version-only tests do not protect custom tags, NDJSON completion or cancellation.
// These unit cases invoke streamOllamaPull with in-memory HTTP events, without sockets or sleeps.
describe('streamOllamaPull regression contract', () => {
  afterEach(() => vi.restoreAllMocks());

  function mockPull(chunks: string[]) {
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setEncoding: vi.fn(),
    });
    const request = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      destroy: vi.fn(),
      end: () =>
        queueMicrotask(() => {
          callback(response as unknown as http.IncomingMessage);
          for (const chunk of chunks) response.emit('data', chunk);
          response.emit('end');
        }),
    });
    let callback: (response: http.IncomingMessage) => void;
    const requestSpy = vi.spyOn(http, 'request').mockImplementation(((
      _options: unknown,
      onResponse: typeof callback,
    ) => {
      callback = onResponse;
      return request;
    }) as typeof http.request);
    return { request, requestSpy };
  }

  it('keeps a custom tag and handles fragmented NDJSON with final success without a newline', async () => {
    const { request } = mockPull(['{"status":"pulling mani', 'fest"}\n{"status":"suc', 'cess"}']);
    const onEvent = vi.fn();
    await expect(
      streamOllamaPull('hf.co/example/Example-GGUF:Q6_K', onEvent),
    ).resolves.toBeUndefined();
    expect(request.write).toHaveBeenCalledWith(
      JSON.stringify({ name: 'hf.co/example/Example-GGUF:Q6_K', stream: true }),
    );
    expect(onEvent).toHaveBeenLastCalledWith({ status: 'success' });
  });

  it('rejects EOF without a success event', async () => {
    mockPull(['{"status":"pulling manifest"}\n']);
    await expect(streamOllamaPull('example:Q6_K', vi.fn())).rejects.toThrow(
      'ollama pull ended without success',
    );
  });

  it('does not make a request when already canceled', async () => {
    const { requestSpy } = mockPull([]);
    const controller = new AbortController();
    controller.abort();
    await expect(streamOllamaPull('example:Q6_K', vi.fn(), controller.signal)).rejects.toThrow(
      'aborted',
    );
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('destroys the request when canceled during streaming', async () => {
    const { request } = mockPull(['{"status":"pulling manifest"}\n']);
    const controller = new AbortController();
    await expect(
      streamOllamaPull('example:Q6_K', () => controller.abort(), controller.signal),
    ).rejects.toThrow('aborted');
    expect(request.destroy).toHaveBeenCalledOnce();
  });

  it('keeps a streamed DNS failure generic through the actual pull entry', async () => {
    mockPull(['{"error":"lookup models404.example: no such host"}\n']);
    const error = await streamOllamaPull('example:Q6_K', vi.fn()).catch((error: unknown) => error);
    expect(error).toMatchObject({
      kind: 'invalid',
      message: 'lookup models404.example: no such host',
    });
    expect(classifyOllamaPullError(error)).toBe('generic');
  });
});
