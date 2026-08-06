import { describe, expect, it, vi } from 'vitest';

import {
  buildCindySearchUrl,
  CINDY_SEARCH_MODEL_NAME,
  createCindyProxySearchService,
} from '../cindyProxySearch';

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('cindyProxySearch', () => {
  it('supports LiteLLM hosts stored with or without the /v1 suffix', () => {
    expect(buildCindySearchUrl('https://gateway.example.test')).toBe(
      'https://gateway.example.test/v1/messages',
    );
    expect(buildCindySearchUrl('https://gateway.example.test/v1/')).toBe(
      'https://gateway.example.test/v1/messages',
    );
    expect(buildCindySearchUrl('https://gateway.example.test/v1/messages')).toBe(
      'https://gateway.example.test/v1/messages',
    );
    expect(buildCindySearchUrl('https://gateway.example.test/V1/')).toBe(
      'https://gateway.example.test/V1/messages',
    );
    expect(buildCindySearchUrl('https://gateway.example.test/V1/Messages')).toBe(
      'https://gateway.example.test/V1/Messages',
    );
    expect(
      buildCindySearchUrl('https://gateway.example.test/api/v1?tenant=alpha&mode=fast#local'),
    ).toBe('https://gateway.example.test/api/v1/messages?tenant=alpha&mode=fast');
  });

  it('固定调用 cindy/web-search 的 Messages Web Search，并解析工具结果与 citations', async () => {
    const fetchImpl = vi.fn(async () =>
      response(
        {
          id: 'msg-search-123',
          usage: { server_tool_use: { web_search_requests: 2 } },
          content: [
            {
              type: 'web_search_tool_result',
              content: [
                {
                  type: 'web_search_result',
                  title: 'Cindy',
                  url: 'https://example.test/cindy',
                },
                {
                  type: 'web_search_result',
                  title: '',
                  url: 'https://example.test/second',
                },
              ],
            },
            {
              type: 'text',
              text: '搜索结果已整理。',
              citations: [
                {
                  type: 'web_search_result_location',
                  title: 'Cindy',
                  url: 'https://example.test/cindy',
                  cited_text: 'Cindy search result',
                },
                {
                  type: 'web_search_result_location',
                  title: 'Second',
                  url: 'https://example.test/second',
                  cited_text: 'Second search result',
                },
                {
                  type: 'web_search_result_location',
                  title: 'Citation only',
                  url: 'https://example.test/citation-only',
                  cited_text: 'Citation-only result',
                },
              ],
            },
          ],
        },
        { headers: { 'x-litellm-call-id': 'call-123' } },
      ),
    ) as unknown as typeof fetch;
    const service = createCindyProxySearchService({
      getBaseUrl: () => 'https://gateway.example.test/',
      getApiKey: () => 'test-key',
      fetchImpl,
    });

    const result = await service.search({ query: 'Cindy', limit: 3 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://gateway.example.test/v1/messages');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'x-api-key': 'test-key',
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: CINDY_SEARCH_MODEL_NAME,
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'Cindy' }],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 1,
        },
      ],
    });
    expect(result).toEqual({
      ok: true,
      requestId: 'call-123',
      webSearchRequests: 2,
      results: [
        {
          title: 'Cindy',
          url: 'https://example.test/cindy',
          snippet: 'Cindy search result',
        },
        {
          title: 'Second',
          url: 'https://example.test/second',
          snippet: 'Second search result',
        },
        {
          title: 'Citation only',
          url: 'https://example.test/citation-only',
          snippet: 'Citation-only result',
        },
      ],
    });
  });

  it('未配置 endpoint/key 时 fail closed，且不发请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const [baseUrl, apiKey] of [
      ['', 'test-key'],
      ['https://gateway.example.test', null],
    ] as const) {
      const service = createCindyProxySearchService({
        getBaseUrl: () => baseUrl,
        getApiKey: () => apiKey,
        fetchImpl,
      });
      await expect(service.search({ query: 'Cindy', limit: 5 })).resolves.toMatchObject({
        ok: false,
        errorCode: 'NOT_CONFIGURED',
        requestStarted: false,
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('归一化鉴权、额度、限流、服务不可用和非法响应错误', async () => {
    const cases = [
      { status: 401, body: { error: 'insufficient scope' }, code: 'AUTH_REJECTED' },
      { status: 403, body: { error: 'insufficient permissions' }, code: 'AUTH_REJECTED' },
      { status: 402, body: { error: 'insufficient balance' }, code: 'QUOTA_EXHAUSTED' },
      { status: 429, body: { error: 'rate limit' }, code: 'RATE_LIMITED' },
      { status: 503, body: { error: 'unavailable' }, code: 'UPSTREAM_UNAVAILABLE' },
    ] as const;

    for (const testCase of cases) {
      const service = createCindyProxySearchService({
        getBaseUrl: () => 'https://gateway.example.test',
        getApiKey: () => 'test-key',
        fetchImpl: vi.fn(async () =>
          response(testCase.body, { status: testCase.status }),
        ) as unknown as typeof fetch,
      });
      await expect(service.search({ query: 'Cindy', limit: 5 })).resolves.toMatchObject({
        ok: false,
        errorCode: testCase.code,
        requestStarted: true,
        status: testCase.status,
      });
    }

    const malformed = createCindyProxySearchService({
      getBaseUrl: () => 'https://gateway.example.test',
      getApiKey: () => 'test-key',
      fetchImpl: vi.fn(async () =>
        response({
          content: [
            {
              type: 'web_search_tool_result',
              content: [{ type: 'web_search_result', title: 'missing url' }],
            },
          ],
        }),
      ) as unknown as typeof fetch,
    });
    await expect(malformed.search({ query: 'Cindy', limit: 5 })).resolves.toMatchObject({
      ok: false,
      errorCode: 'RESPONSE_INVALID',
    });
  });

  it('将无匹配结果和未触发搜索工具视为有效空结果', async () => {
    for (const body of [
      {
        content: [{ type: 'web_search_tool_result', content: [] }],
      },
      {
        content: [{ type: 'text', text: 'No web search was needed.' }],
      },
    ]) {
      const service = createCindyProxySearchService({
        getBaseUrl: () => 'https://gateway.example.test',
        getApiKey: () => 'test-key',
        fetchImpl: vi.fn(async () => response(body)) as unknown as typeof fetch,
      });

      await expect(service.search({ query: 'Cindy', limit: 5 })).resolves.toMatchObject({
        ok: true,
        results: [],
      });
    }
  });

  it('归一化 Messages Web Search 的 HTTP 200 工具级错误', async () => {
    const cases = [
      { upstream: 'too_many_requests', code: 'RATE_LIMITED' },
      { upstream: 'max_uses_exceeded', code: 'RATE_LIMITED' },
      { upstream: 'invalid_tool_input', code: 'INVALID_PARAMS' },
      { upstream: 'query_too_long', code: 'INVALID_PARAMS' },
      { upstream: 'unavailable', code: 'UPSTREAM_UNAVAILABLE' },
    ] as const;

    for (const testCase of cases) {
      const service = createCindyProxySearchService({
        getBaseUrl: () => 'https://gateway.example.test',
        getApiKey: () => 'test-key',
        fetchImpl: vi.fn(async () =>
          response({
            content: [
              {
                type: 'web_search_tool_result',
                content: {
                  type: 'web_search_tool_result_error',
                  error_code: testCase.upstream,
                },
              },
            ],
          }),
        ) as unknown as typeof fetch,
      });

      await expect(service.search({ query: 'Cindy', limit: 5 })).resolves.toMatchObject({
        ok: false,
        errorCode: testCase.code,
        status: 200,
      });
    }
  });

  it('响应体读取中断时返回可重试的上游错误并保留诊断元数据', async () => {
    const warn = vi.fn();
    const service = createCindyProxySearchService({
      getBaseUrl: () => 'https://gateway.example.test',
      getApiKey: () => 'test-key',
      fetchImpl: vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'x-request-id': 'request-body-failed' }),
          text: vi.fn(async () => {
            throw new Error('stream interrupted');
          }),
        }) as unknown as Response,
      ) as unknown as typeof fetch,
      log: { info: vi.fn(), warn },
    });

    await expect(service.search({ query: 'Cindy', limit: 5 })).resolves.toMatchObject({
      ok: false,
      errorCode: 'UPSTREAM_UNAVAILABLE',
      requestStarted: true,
      status: 200,
      requestId: 'request-body-failed',
    });
    expect(warn).toHaveBeenCalledWith(
      'cindy search response body failed',
      expect.objectContaining({
        status: 200,
        requestId: 'request-body-failed',
        error: 'body read failure',
      }),
    );
  });

  it('日志只包含状态元数据，不包含 query 或 Authorization', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const service = createCindyProxySearchService({
      getBaseUrl: () => 'https://gateway.example.test',
      getApiKey: () => 'super-secret-test-key',
      fetchImpl: vi.fn(async () =>
        response({
          content: [
            {
              type: 'web_search_tool_result',
              content: [
                {
                  type: 'web_search_result',
                  title: 'Result',
                  url: 'https://example.test/result',
                },
              ],
            },
          ],
        }),
      ) as unknown as typeof fetch,
      log: { info, warn },
    });

    await service.search({ query: 'sensitive user query', limit: 5 });

    const logged = JSON.stringify([info.mock.calls, warn.mock.calls]);
    expect(logged).not.toContain('sensitive user query');
    expect(logged).not.toContain('super-secret-test-key');
  });
});
