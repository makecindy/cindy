import { afterEach, describe, expect, it, vi } from 'vitest';

// CodexResponsesTextModelClient uses undici.fetch + Agent for the shared
// keepalive pool. Keep the real Undici exports and replace only fetch so the
// tests stay hermetic without changing the transport module's shape.
const undiciFetchMock = vi.fn();
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetch: (...args: unknown[]) => undiciFetchMock(...args),
  };
});

import { CodexResponsesTextModelClient } from '../CodexResponsesTextModelClient.js';

function makeSseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const body = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('CodexResponsesTextModelClient', () => {
  afterEach(() => {
    undiciFetchMock.mockReset();
    vi.useRealTimers();
  });

  it('accumulates output_text deltas, parses JSON, and reports usage', async () => {
    const requestRecords: Array<{ url: string; init: RequestInit & { headers: Record<string, string>; body: string } }> = [];
    undiciFetchMock.mockImplementation(async (url: string, init: { headers: Record<string, string>; body: string } & RequestInit) => {
      requestRecords.push({ url, init });
      return makeSseResponse([
        { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1' } } },
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '{"tex' } },
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 't":"整理后' } },
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '的文本。"}' } },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: {
              id: 'resp_1',
              usage: {
                input_tokens: 1200,
                input_tokens_details: { cached_tokens: 1024 },
                output_tokens: 8,
                total_tokens: 1208,
              },
            },
          },
        },
      ]);
    });

    const usages: Array<{ promptTokens?: number; completionTokens?: number; cachedTokens?: number }> = [];
    const snapshots: string[] = [];
    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => 'codex-access-token',
      accountIdProvider: async () => 'account-xyz',
      onUsage: (usage) => usages.push(usage),
    });

    const result = await client.requestJson<{ text: string }>({
      model: 'gpt-5.4-mini',
      schemaName: 'dictation_refinement',
      system: '系统提示词',
      user: { promptVersion: 'dictation-refinement.zh.v16', dictationText: '测试。' },
      promptCacheScope: 'session-1',
      onTextSnapshot: (text) => snapshots.push(text),
    });

    expect(result).toEqual({ text: '整理后的文本。' });
    expect(snapshots).toEqual(['整理后', '整理后的文本。']);
    expect(usages).toEqual([{ promptTokens: 1200, completionTokens: 8, cachedTokens: 1024 }]);

    expect(requestRecords).toHaveLength(1);
    const record = requestRecords[0];
    expect(record.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(record.init.method).toBe('POST');
    expect(record.init.headers.Authorization).toBe('Bearer codex-access-token');
    expect(record.init.headers['ChatGPT-Account-Id']).toBe('account-xyz');
    expect(record.init.headers['OpenAI-Beta']).toBe('responses=experimental');
    expect(record.init.headers.originator).toBe('codex_cli_rs');
    expect(record.init.headers.Accept).toBe('text/event-stream');

    const sent = JSON.parse(record.init.body) as Record<string, unknown>;
    expect(sent.model).toBe('gpt-5.4-mini');
    expect(sent.stream).toBe(true);
    expect(sent.store).toBe(false);
    expect(sent.instructions).toBe('系统提示词');
    expect(sent.prompt_cache_key).toMatch(/^xdt:dictation_refinement:[a-f0-9]{20}$/);
    expect(Array.isArray(sent.input)).toBe(true);
    const input = sent.input as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(input).toHaveLength(1);
    expect(input[0].role).toBe('user');
    expect(input[0].content[0].type).toBe('input_text');
    const inner = JSON.parse(input[0].content[0].text) as Record<string, unknown>;
    expect(inner.schemaName).toBe('dictation_refinement');
    expect(inner.input).toMatchObject({ dictationText: '测试。' });
  });

  it('treats timeout as stream-idle instead of total request duration', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    undiciFetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"delta":"{\\"text\\":\\"长"}\n\n'));
        }, 4_000);
        setTimeout(() => {
          controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"delta":"文本"}\n\n'));
        }, 8_000);
        setTimeout(() => {
          controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"delta":"完成\\"}"}\n\n'));
          controller.close();
        }, 12_000);
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const snapshots: string[] = [];
    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => 'tok',
      accountIdProvider: async () => null,
      timeoutMs: 5_000,
    });
    const promise = client.requestJson<{ text: string }>({
      model: 'm',
      schemaName: 's',
      system: 'sys',
      user: {},
      onTextSnapshot: (text) => snapshots.push(text),
    });

    await vi.advanceTimersByTimeAsync(12_000);
    await expect(promise).resolves.toEqual({ text: '长文本完成' });
    expect(snapshots).toEqual(['长', '长文本', '长文本完成']);
  });

  it('keeps the same prompt_cache_key across calls with identical scope', async () => {
    const sentKeys: string[] = [];
    undiciFetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { prompt_cache_key: string };
      sentKeys.push(body.prompt_cache_key);
      return makeSseResponse([
        { event: 'response.output_text.delta', data: { delta: '{"text":"ok"}' } },
        { event: 'response.completed', data: { response: { usage: {} } } },
      ]);
    });

    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => 'tok',
      accountIdProvider: async () => null,
    });
    const input = {
      model: 'gpt-5.4-mini',
      schemaName: 'dictation_refinement',
      system: 'sys',
      user: { promptVersion: 'v1', x: 1 },
      promptCacheScope: 'session-1',
    };
    await client.requestJson(input);
    await client.requestJson(input);
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[0]).toBe(sentKeys[1]);
  });

  it('omits ChatGPT-Account-Id when accountIdProvider returns null', async () => {
    let captured: Record<string, string> | null = null;
    undiciFetchMock.mockImplementation(async (_url: string, init: { headers: Record<string, string> }) => {
      captured = init.headers;
      return makeSseResponse([
        { event: 'response.output_text.delta', data: { delta: '{"text":"ok"}' } },
        { event: 'response.completed', data: { response: { usage: {} } } },
      ]);
    });

    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => 'tok',
      accountIdProvider: async () => null,
    });
    await client.requestJson({
      model: 'm', schemaName: 's', system: 'sys', user: {},
    });

    expect(captured).not.toBeNull();
    expect(captured!).not.toHaveProperty('ChatGPT-Account-Id');
  });

  it('throws Missing Codex access token without invalidating auth when provider returns null', async () => {
    const onAuthInvalidated = vi.fn();
    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => null,
      accountIdProvider: async () => 'a',
      onAuthInvalidated,
    });
    await expect(client.requestJson({
      model: 'm', schemaName: 's', system: 'sys', user: {},
    })).rejects.toThrow(/Missing Codex access token/);
    expect(onAuthInvalidated).not.toHaveBeenCalled();
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it('runs the final dispatch guard after request awaits and can fail closed on owner drift', async () => {
    let ownerScope = 'owner-a';
    const beforeDispatch = vi.fn(() => {
      if (ownerScope !== 'owner-a') throw new Error('voice input owner scope changed');
    });
    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => {
        ownerScope = 'owner-b';
        return 'tok';
      },
      accountIdProvider: async () => null,
      beforeDispatch,
    });

    await expect(client.requestJson({
      model: 'm', schemaName: 's', system: 'sys', user: {},
    })).rejects.toThrow('voice input owner scope changed');
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it('surfaces stream-level errors from response.failed events', async () => {
    const onAuthInvalidated = vi.fn();
    undiciFetchMock.mockResolvedValue(makeSseResponse([
      {
        event: 'response.failed',
        data: { type: 'response.failed', response: { error: { message: 'model temporarily unavailable' } } },
      },
    ]));
    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => 'tok',
      accountIdProvider: async () => null,
      onAuthInvalidated,
    });
    await expect(client.requestJson({
      model: 'm', schemaName: 's', system: 'sys', user: {},
    })).rejects.toThrow(/model temporarily unavailable/);
    expect(onAuthInvalidated).not.toHaveBeenCalled();
  });

  it('notifies auth invalidation on Codex HTTP auth errors', async () => {
    const onAuthInvalidated = vi.fn();
    undiciFetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'token_invalidated',
        message: 'authentication token has been invalidated',
      },
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => 'tok',
      accountIdProvider: async () => null,
      onAuthInvalidated,
    });
    await expect(client.requestJson({
      model: 'm', schemaName: 's', system: 'sys', user: {},
    })).rejects.toThrow(/HTTP 401.*authentication token has been invalidated/);
    expect(onAuthInvalidated).toHaveBeenCalledTimes(1);
    expect(onAuthInvalidated).toHaveBeenCalledWith('token_invalidated');
  });

  it('includes normalized auth reason in generic Codex HTTP auth errors', async () => {
    const onAuthInvalidated = vi.fn();
    undiciFetchMock.mockResolvedValue(new Response('Unauthorized', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' },
    }));
    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => 'tok',
      accountIdProvider: async () => null,
      onAuthInvalidated,
    });
    await expect(client.requestJson({
      model: 'm', schemaName: 's', system: 'sys', user: {},
    })).rejects.toThrow(/token_invalidated: Codex responses HTTP 401/);
    expect(onAuthInvalidated).toHaveBeenCalledTimes(1);
    expect(onAuthInvalidated).toHaveBeenCalledWith('token_invalidated');
  });

  it('notifies auth invalidation on Codex stream auth errors', async () => {
    const onAuthInvalidated = vi.fn();
    undiciFetchMock.mockResolvedValue(makeSseResponse([
      {
        event: 'response.failed',
        data: {
          type: 'response.failed',
          response: {
            error: { message: 'Your session has ended. Please log in again.' },
          },
        },
      },
    ]));
    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => 'tok',
      accountIdProvider: async () => null,
      onAuthInvalidated,
    });
    await expect(client.requestJson({
      model: 'm', schemaName: 's', system: 'sys', user: {},
    })).rejects.toThrow(/Your session has ended/);
    expect(onAuthInvalidated).toHaveBeenCalledTimes(1);
    expect(onAuthInvalidated).toHaveBeenCalledWith('app_session_terminated');
  });

  it('notifies auth invalidation from Codex stream error codes', async () => {
    const onAuthInvalidated = vi.fn();
    undiciFetchMock.mockResolvedValue(makeSseResponse([
      {
        event: 'response.failed',
        data: {
          type: 'response.failed',
          response: {
            error: { code: 'token_invalidated', message: 'Unauthorized' },
          },
        },
      },
    ]));
    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => 'tok',
      accountIdProvider: async () => null,
      onAuthInvalidated,
    });
    await expect(client.requestJson({
      model: 'm', schemaName: 's', system: 'sys', user: {},
    })).rejects.toThrow(/token_invalidated: Unauthorized/);
    expect(onAuthInvalidated).toHaveBeenCalledTimes(1);
    expect(onAuthInvalidated).toHaveBeenCalledWith('token_invalidated');
  });

  it('rejects oversized streamed output before parsing JSON', async () => {
    undiciFetchMock.mockResolvedValue(makeSseResponse([
      {
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', delta: 'x'.repeat(64_001) },
      },
    ]));
    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => 'tok',
      accountIdProvider: async () => null,
    });
    await expect(client.requestJson({
      model: 'm', schemaName: 's', system: 'sys', user: {},
    })).rejects.toThrow(/output exceeded 64000 characters/);
  });

  it('surfaces HTTP errors with body excerpt', async () => {
    undiciFetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'rate_limited' },
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new CodexResponsesTextModelClient({
      accessTokenProvider: async () => 'tok',
      accountIdProvider: async () => null,
    });
    await expect(client.requestJson({
      model: 'm', schemaName: 's', system: 'sys', user: {},
    })).rejects.toThrow(/HTTP 429.*rate_limited/);
  });
});
