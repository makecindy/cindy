import { afterEach, describe, expect, it, vi } from 'vitest';

const undiciFetchMock = vi.fn();
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetch: (...args: unknown[]) => undiciFetchMock(...args),
  };
});

import { LiteLlmTextModelClient } from '../LiteLlmTextModelClient.js';
import { isRefinerModelOutputError } from '../refinerErrorKind.js';

function makeChatCompletionSseResponse(events: unknown[], lineBreak = '\n'): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}${lineBreak}${lineBreak}`)
    .join('') + `data: [DONE]${lineBreak}${lineBreak}`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function chatCompletionSseChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

describe('LiteLlmTextModelClient', () => {
  afterEach(() => {
    undiciFetchMock.mockReset();
    vi.useRealTimers();
  });

  it('streams chat completion deltas, emits text snapshots, and reports usage', async () => {
    const usages: Array<{ promptTokens?: number; completionTokens?: number; cachedTokens?: number }> = [];
    const snapshots: string[] = [];
    let requestBody: Record<string, unknown> | null = null;
    undiciFetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      requestBody = JSON.parse(init.body) as Record<string, unknown>;
      return makeChatCompletionSseResponse([
        { choices: [{ delta: { content: '{"tex' } }] },
        { choices: [{ delta: { content: 't":"整理后' } }] },
        { choices: [{ delta: { content: '的文本。"}' } }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 8,
            prompt_tokens_details: { cached_tokens: 1024 },
          },
        },
      ]);
    });

    const client = new LiteLlmTextModelClient({
      proxyApiKey: 'proxy-key',
      baseUrl: 'https://llm-proxy.example.com',
      onUsage: (usage) => usages.push(usage),
    });
    await expect(client.requestJson<{ text: string }>({
      model: 'qwen/qwen3.6-plus',
      schemaName: 'dictation_refinement',
      system: '系统提示词',
      user: { promptVersion: 'dictation-refinement.zh.v16', dictationText: '测试。' },
      promptCacheScope: 'session-1',
      onTextSnapshot: (text) => snapshots.push(text),
    })).resolves.toEqual({ text: '整理后的文本。' });

    expect(snapshots).toEqual(['整理后', '整理后的文本。']);
    expect(usages).toEqual([{ promptTokens: 1200, completionTokens: 8, cachedTokens: 1024 }]);
    expect(requestBody).toMatchObject({
      model: 'qwen/qwen3.6-plus',
      response_format: { type: 'json_object' },
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('parses CRLF-delimited SSE frames from LiteLLM gateways', async () => {
    undiciFetchMock.mockImplementation(async () => makeChatCompletionSseResponse([
      { choices: [{ delta: { content: '{"text":"CRLF' } }] },
      { choices: [{ delta: { content: ' 分隔也能解析"}' } }] },
    ], '\r\n'));

    const snapshots: string[] = [];
    const client = new LiteLlmTextModelClient({
      proxyApiKey: 'proxy-key',
      baseUrl: 'https://llm-proxy.example.com',
    });

    await expect(client.requestJson<{ text: string }>({
      model: 'm',
      schemaName: 's',
      system: 'sys',
      user: {},
      onTextSnapshot: (text) => snapshots.push(text),
    })).resolves.toEqual({ text: 'CRLF 分隔也能解析' });
    expect(snapshots).toEqual(['CRLF', 'CRLF 分隔也能解析']);
  });

  it('marks malformed model output as a model-output error (not transport)', async () => {
    undiciFetchMock.mockImplementation(async () => makeChatCompletionSseResponse([
      { choices: [{ delta: { content: '这不是 JSON' } }] },
    ]));

    const client = new LiteLlmTextModelClient({
      proxyApiKey: 'proxy-key',
      baseUrl: 'https://llm-proxy.example.com',
    });

    const error = await client.requestJson<{ text: string }>({
      model: 'm',
      schemaName: 's',
      system: 'sys',
      user: {},
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(isRefinerModelOutputError(error)).toBe(true);
  });

  it('does not mark HTTP transport failures as model-output errors', async () => {
    undiciFetchMock.mockImplementation(async () => new Response('upstream exploded', { status: 502 }));

    const client = new LiteLlmTextModelClient({
      proxyApiKey: 'proxy-key',
      baseUrl: 'https://llm-proxy.example.com',
    });

    const error = await client.requestJson<{ text: string }>({
      model: 'm',
      schemaName: 's',
      system: 'sys',
      user: {},
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(isRefinerModelOutputError(error)).toBe(false);
  });

  it('refreshes a managed request target and retries once after HTTP 401', async () => {
    const requestTargetProvider = vi.fn(async (options?: { forceRefresh?: boolean }) => ({
      url: 'https://voice.example.com/api/voice/sessions/session-1/refine',
      authorization: options?.forceRefresh ? 'Bearer fresh-token' : 'Bearer stale-token',
    }));
    undiciFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'TOKEN_EXPIRED', message: 'expired' },
      }), { status: 401 }))
      .mockResolvedValueOnce(makeChatCompletionSseResponse([
        { choices: [{ delta: { content: '{"text":"refined"}' } }] },
      ]));

    const beforeDispatch = vi.fn();
    const client = new LiteLlmTextModelClient({ requestTargetProvider, beforeDispatch });

    await expect(client.requestJson<{ text: string }>({
      model: 'm',
      schemaName: 's',
      system: 'sys',
      user: {},
    })).resolves.toEqual({ text: 'refined' });

    expect(requestTargetProvider).toHaveBeenNthCalledWith(1, undefined);
    expect(requestTargetProvider).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(undiciFetchMock).toHaveBeenCalledTimes(2);
    expect(beforeDispatch).toHaveBeenCalledTimes(2);
    expect(undiciFetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer stale-token' }),
    });
    expect(undiciFetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer fresh-token' }),
    });
  });

  it('uses stream-idle timeout instead of total request duration', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    undiciFetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode(chatCompletionSseChunk('{"text":"长')));
        }, 4_000);
        setTimeout(() => {
          controller.enqueue(encoder.encode(chatCompletionSseChunk('文本')));
        }, 8_000);
        setTimeout(() => {
          controller.enqueue(encoder.encode(chatCompletionSseChunk('完成"}')));
          controller.close();
        }, 12_000);
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const snapshots: string[] = [];
    const client = new LiteLlmTextModelClient({
      proxyApiKey: 'proxy-key',
      baseUrl: 'https://llm-proxy.example.com',
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
});
