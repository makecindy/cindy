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
      // 网关预算闸的真实形态:HTTP 429 + ExceededBudget(#4024)—— 是余额耗尽,不是限流。
      {
        status: 429,
        body: { error: 'ExceededBudget', principal: 'aigw:user-1', spend: 12.34, budget: 10 },
        code: 'QUOTA_EXHAUSTED',
      },
      { status: 429, body: { error: 'budget_exceeded' }, code: 'QUOTA_EXHAUSTED' },
      // 瞬时限流照旧,即便正文带 credit 之类宽松措辞也不得升级成「去充值」。
      { status: 429, body: { error: 'rate limit' }, code: 'RATE_LIMITED' },
      { status: 429, body: { error: 'Too Many Requests' }, code: 'RATE_LIMITED' },
      {
        status: 429,
        body: { error: 'rate limit exceeded, credits refill in 60s' },
        code: 'RATE_LIMITED',
      },
      { status: 404, body: { error: 'not found' }, code: 'NOT_CONFIGURED' },
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
      fetchImpl: vi.fn(
        async () =>
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

  it('余额耗尽(429 + ExceededBudget)给出充值引导,日志只留允许名单内的结构化摘要', async () => {
    const warn = vi.fn();
    const service = createCindyProxySearchService({
      getBaseUrl: () => 'https://gateway.example.test',
      getApiKey: () => 'super-secret-test-key',
      fetchImpl: vi.fn(async () =>
        response(
          {
            error: 'ExceededBudget',
            principal: 'aigw:internal-user-42',
            spend: 12.34,
            budget: 10,
            token: 'placeholder-credential-must-not-be-logged',
            echo: 'sensitive user query',
            padding: 'x'.repeat(600),
          },
          { status: 429, headers: { 'x-request-id': 'req-quota-1' } },
        ),
      ) as unknown as typeof fetch,
      log: { info: vi.fn(), warn },
    });

    const outcome = await service.search({ query: 'sensitive user query', limit: 5 });
    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'QUOTA_EXHAUSTED',
      status: 429,
      requestId: 'req-quota-1',
    });
    expect(outcome.ok === false && outcome.message).toContain('余额不足');
    expect(outcome.ok === false && outcome.message).toContain('充值');

    expect(warn).toHaveBeenCalledTimes(1);
    const [, meta] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta.errorCode).toBe('QUOTA_EXHAUSTED');
    // 摘要是允许名单式的结构化字段,不是任意正文:principal / 凭证 / 回显字段一律不进日志。
    expect(meta.bodyDigest).toEqual({
      json: true,
      length: expect.any(Number),
      error: 'ExceededBudget',
      spend: 12.34,
      budget: 10,
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('internal-user-42');
    expect(logged).not.toContain('aigw:');
    expect(logged).not.toContain('placeholder-credential-must-not-be-logged');
    expect(logged).not.toContain('sensitive user query');
    expect(logged).not.toContain('super-secret-test-key');
    expect(logged).not.toContain('xxxx');
  });

  it('非标识形态的 error 文本与非 JSON 正文只记长度,不落盘内容', async () => {
    const cases: Array<{ body: BodyInit; expected: Record<string, unknown> }> = [
      {
        body: JSON.stringify({
          error: {
            type: 'rate_limit_error',
            message: 'slow down, user asked: sensitive user query',
          },
        }),
        expected: { json: true, error: 'rate_limit_error', type: 'rate_limit_error' },
      },
      {
        body: JSON.stringify({ error: 'insufficient balance for sensitive user query' }),
        expected: { json: true },
      },
      { body: '<html>Bad Gateway sensitive user query</html>', expected: { json: false } },
    ];
    for (const testCase of cases) {
      const warn = vi.fn();
      const service = createCindyProxySearchService({
        getBaseUrl: () => 'https://gateway.example.test',
        getApiKey: () => 'test-key',
        fetchImpl: vi.fn(
          async () => new Response(testCase.body, { status: 502 }),
        ) as unknown as typeof fetch,
        log: { info: vi.fn(), warn },
      });
      await service.search({ query: 'sensitive user query', limit: 5 });
      const [, meta] = warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(meta.bodyDigest).toMatchObject(testCase.expected);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive user query');
    }
  });
});
