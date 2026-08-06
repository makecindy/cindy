import { getAppCapabilities } from '../appCapabilities.js';
import { createLogger } from '../logger.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';

export const CINDY_SEARCH_MODEL_NAME = 'cindy/web-search';
const CINDY_SEARCH_WEB_TOOL_TYPE = 'web_search_20250305';
const CINDY_SEARCH_MAX_TOKENS = 2_048;
const CINDY_SEARCH_TIMEOUT_MS = 30_000;

/**
 * Join the Anthropic-compatible Messages endpoint for either a gateway root or
 * a `/v1` base returned by the logged-in Cindy gateway configuration.
 */
export function buildCindySearchUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  try {
    const url = new URL(normalizedBaseUrl);
    const pathname = url.pathname.replace(/\/+$/, '');
    const lowerPathname = pathname.toLowerCase();
    if (lowerPathname === '/v1/messages' || lowerPathname.endsWith('/v1/messages')) {
      url.pathname = pathname || '/v1/messages';
    } else {
      const suffix =
        lowerPathname === '/v1' || lowerPathname.endsWith('/v1') ? '/messages' : '/v1/messages';
      url.pathname = `${pathname}${suffix}` || '/v1/messages';
    }
    url.hash = '';
    return url.toString();
  } catch {
    // The caller validates configured URLs; retaining the old path makes this
    // helper harmless for injected unit-test values as well.
  }
  const suffix = normalizedBaseUrl.endsWith('/v1') ? '/messages' : '/v1/messages';
  return `${normalizedBaseUrl}${suffix}`;
}

export type CindyProxySearchErrorCode =
  | 'NOT_CONFIGURED'
  | 'QUOTA_EXHAUSTED'
  | 'AUTH_REJECTED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INVALID_PARAMS'
  | 'RESPONSE_INVALID'
  | 'INTERNAL';

export interface CindyProxySearchItem {
  title: string;
  url: string;
  snippet: string;
}

export type CindyProxySearchOutcome =
  | {
      ok: true;
      results: CindyProxySearchItem[];
      requestId?: string;
      webSearchRequests?: number;
    }
  | {
      ok: false;
      errorCode: CindyProxySearchErrorCode;
      message: string;
      /** true 表示已进入 fetch，不能证明本次请求未消耗上游配额。 */
      requestStarted: boolean;
      status?: number;
      requestId?: string;
    };

export interface CindyProxySearchService {
  search(params: { query: string; limit: number }): Promise<CindyProxySearchOutcome>;
}

export interface CindyProxySearchDeps {
  getBaseUrl(): string;
  getApiKey(): string | null;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  log?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

function requestIdOf(response: Response): string | undefined {
  return (
    response.headers.get('x-litellm-call-id') ?? response.headers.get('x-request-id') ?? undefined
  );
}

function classifyHttpFailure(
  status: number,
  body: string,
): { errorCode: CindyProxySearchErrorCode; message: string } {
  const normalized = body.slice(0, 1024).toLowerCase();
  if (status === 401 || status === 403) {
    return {
      errorCode: 'AUTH_REJECTED',
      message: 'Cindy AI 搜索鉴权失败，请重新登录或稍后再试',
    };
  }
  const looksLikeQuota =
    status === 402 ||
    /(?:quota|credit|balance|insufficient|exhausted|spend limit)/.test(normalized);
  if (looksLikeQuota) {
    return {
      errorCode: 'QUOTA_EXHAUSTED',
      message: 'Cindy AI 搜索额度不足，请稍后再试或在插件设置中改用自己的搜索渠道',
    };
  }
  if (status === 404) {
    return {
      errorCode: 'NOT_CONFIGURED',
      message: 'Cindy AI 搜索服务尚未配置，请稍后再试',
    };
  }
  if (
    (status === 400 || status === 422) &&
    /(?:invalid|unknown|not found|does not exist).{0,80}model|model.{0,80}(?:invalid|unknown|not found|does not exist)/.test(
      normalized,
    )
  ) {
    return {
      errorCode: 'NOT_CONFIGURED',
      message: 'Cindy AI 搜索模型尚未配置，请稍后再试',
    };
  }
  if (status === 429) {
    return {
      errorCode: 'RATE_LIMITED',
      message: 'Cindy AI 搜索请求过于频繁，请稍后再试',
    };
  }
  if (status >= 500) {
    return {
      errorCode: 'UPSTREAM_UNAVAILABLE',
      message: 'Cindy AI 搜索服务暂时不可用，请稍后再试',
    };
  }
  if (status === 400 || status === 422) {
    return {
      errorCode: 'INVALID_PARAMS',
      message: 'Cindy AI 搜索请求参数未被服务接受',
    };
  }
  return {
    errorCode: 'INTERNAL',
    message: 'Cindy AI 搜索失败，请稍后再试',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizedHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function fallbackTitle(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

interface SearchSource {
  url: string;
  title: string;
  snippet: string;
}

type ParsedSearchResponse =
  | {
      ok: true;
      results: CindyProxySearchItem[];
    }
  | {
      ok: false;
      errorCode: CindyProxySearchErrorCode;
      message: string;
    };

function sourceFromRecord(value: Record<string, unknown>): SearchSource | null {
  const url = normalizedHttpUrl(value.url);
  if (!url) return null;
  const title =
    typeof value.title === 'string' && value.title.trim().length > 0
      ? value.title.trim()
      : fallbackTitle(url);
  const snippet =
    typeof value.cited_text === 'string'
      ? value.cited_text.trim()
      : typeof value.snippet === 'string'
        ? value.snippet.trim()
        : '';
  return { url, title, snippet };
}

function invalidSearchResponse(): ParsedSearchResponse {
  return {
    ok: false,
    errorCode: 'RESPONSE_INVALID',
    message: 'Cindy AI 搜索返回了无法识别的结果，请稍后再试',
  };
}

function searchToolFailure(errorCode: unknown): ParsedSearchResponse {
  if (errorCode === 'too_many_requests') {
    return {
      ok: false,
      errorCode: 'RATE_LIMITED',
      message: 'Cindy AI 搜索请求过于频繁，请稍后再试',
    };
  }
  if (errorCode === 'max_uses_exceeded') {
    return {
      ok: false,
      errorCode: 'RATE_LIMITED',
      message: 'Cindy AI 搜索已达到本次调用上限，请稍后再试',
    };
  }
  if (errorCode === 'invalid_tool_input' || errorCode === 'query_too_long') {
    return {
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: 'Cindy AI 搜索请求参数未被服务接受',
    };
  }
  if (errorCode === 'unavailable') {
    return {
      ok: false,
      errorCode: 'UPSTREAM_UNAVAILABLE',
      message: 'Cindy AI 搜索服务暂时不可用，请稍后再试',
    };
  }
  return invalidSearchResponse();
}

function parseSearchResponse(raw: unknown, limit: number): ParsedSearchResponse {
  if (!isRecord(raw) || !Array.isArray(raw.content)) {
    return invalidSearchResponse();
  }

  const sources = new Map<string, SearchSource>();
  let sawCandidate = false;
  const mergeSource = (source: SearchSource) => {
    const existing = sources.get(source.url);
    if (!existing) {
      sources.set(source.url, source);
      return;
    }
    if (existing.title === fallbackTitle(existing.url) && source.title !== existing.title) {
      existing.title = source.title;
    }
    if (!existing.snippet && source.snippet) existing.snippet = source.snippet;
  };

  for (const block of raw.content) {
    if (!isRecord(block)) continue;

    if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content)) {
        if (block.content.length > 0) sawCandidate = true;
        for (const item of block.content) {
          if (!isRecord(item) || item.type !== 'web_search_result') continue;
          const source = sourceFromRecord(item);
          if (source) mergeSource(source);
        }
      } else if (isRecord(block.content) && block.content.type === 'web_search_tool_result_error') {
        return searchToolFailure(block.content.error_code);
      } else {
        return invalidSearchResponse();
      }
    }

    if (block.type === 'text' && Array.isArray(block.citations)) {
      if (block.citations.length > 0) sawCandidate = true;
      for (const citation of block.citations) {
        if (!isRecord(citation)) continue;
        const source = sourceFromRecord(citation);
        if (source) mergeSource(source);
      }
    }
  }

  if (sawCandidate && sources.size === 0) return invalidSearchResponse();
  return {
    ok: true,
    results: Array.from(sources.values()).slice(0, limit),
  };
}

function webSearchRequestsOf(raw: unknown): number | undefined {
  if (!isRecord(raw) || !isRecord(raw.usage) || !isRecord(raw.usage.server_tool_use)) {
    return undefined;
  }
  const value = raw.usage.server_tool_use.web_search_requests;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function createCindyProxySearchService(deps: CindyProxySearchDeps): CindyProxySearchService {
  return {
    async search({ query, limit }): Promise<CindyProxySearchOutcome> {
      const baseUrl = deps.getBaseUrl().trim().replace(/\/+$/, '');
      const apiKey = deps.getApiKey();
      if (!baseUrl || !apiKey) {
        return {
          ok: false,
          errorCode: 'NOT_CONFIGURED',
          message: 'Cindy AI 搜索尚未就绪，请重新登录或在插件设置中改用自己的搜索渠道',
          requestStarted: false,
        };
      }

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await deps.fetchImpl(buildCindySearchUrl(baseUrl), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: CINDY_SEARCH_MODEL_NAME,
            max_tokens: CINDY_SEARCH_MAX_TOKENS,
            messages: [{ role: 'user', content: query }],
            tools: [
              {
                type: CINDY_SEARCH_WEB_TOOL_TYPE,
                name: 'web_search',
                max_uses: 1,
              },
            ],
          }),
          signal: AbortSignal.timeout(deps.timeoutMs ?? CINDY_SEARCH_TIMEOUT_MS),
        });
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        deps.log?.warn('cindy search request failed before response', {
          logicalProvider: 'cindy',
          upstreamProtocol: 'anthropic-messages',
          modelAlias: CINDY_SEARCH_MODEL_NAME,
          latencyMs,
          error:
            error instanceof DOMException && error.name === 'TimeoutError'
              ? 'timeout'
              : 'network failure',
        });
        return {
          ok: false,
          errorCode: 'UPSTREAM_UNAVAILABLE',
          message: 'Cindy AI 搜索服务连接失败，请稍后再试',
          requestStarted: true,
        };
      }

      const requestId = requestIdOf(response);
      let body: string;
      try {
        body = await response.text();
      } catch {
        const latencyMs = Date.now() - startedAt;
        deps.log?.warn('cindy search response body failed', {
          logicalProvider: 'cindy',
          upstreamProtocol: 'anthropic-messages',
          modelAlias: CINDY_SEARCH_MODEL_NAME,
          status: response.status,
          latencyMs,
          ...(requestId ? { requestId } : {}),
          error: 'body read failure',
        });
        return {
          ok: false,
          errorCode: 'UPSTREAM_UNAVAILABLE',
          message: 'Cindy AI 搜索响应传输中断，请稍后再试',
          requestStarted: true,
          status: response.status,
          ...(requestId ? { requestId } : {}),
        };
      }
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        const failure = classifyHttpFailure(response.status, body);
        deps.log?.warn('cindy search request rejected', {
          logicalProvider: 'cindy',
          upstreamProtocol: 'anthropic-messages',
          modelAlias: CINDY_SEARCH_MODEL_NAME,
          status: response.status,
          latencyMs,
          ...(requestId ? { requestId } : {}),
          errorCode: failure.errorCode,
        });
        return {
          ok: false,
          ...failure,
          requestStarted: true,
          status: response.status,
          ...(requestId ? { requestId } : {}),
        };
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(body);
      } catch {
        decoded = null;
      }
      const parsed = parseSearchResponse(decoded, limit);
      const webSearchRequests = webSearchRequestsOf(decoded);
      if (!parsed.ok) {
        deps.log?.warn('cindy search response rejected', {
          logicalProvider: 'cindy',
          upstreamProtocol: 'anthropic-messages',
          modelAlias: CINDY_SEARCH_MODEL_NAME,
          status: response.status,
          latencyMs,
          ...(requestId ? { requestId } : {}),
          errorCode: parsed.errorCode,
        });
        return {
          ok: false,
          errorCode: parsed.errorCode,
          message: parsed.message,
          requestStarted: true,
          status: response.status,
          ...(requestId ? { requestId } : {}),
        };
      }
      const results = parsed.results;

      deps.log?.info('cindy search request completed', {
        logicalProvider: 'cindy',
        upstreamProtocol: 'anthropic-messages',
        modelAlias: CINDY_SEARCH_MODEL_NAME,
        status: response.status,
        latencyMs,
        resultCount: results.length,
        ...(webSearchRequests !== undefined ? { webSearchRequests } : {}),
        ...(requestId ? { requestId } : {}),
      });
      return {
        ok: true,
        results,
        ...(webSearchRequests !== undefined ? { webSearchRequests } : {}),
        ...(requestId ? { requestId } : {}),
      };
    },
  };
}

const log = createLogger('search');
let service: CindyProxySearchService | null = null;

export function getCindyProxySearchService(): CindyProxySearchService {
  service ??= createCindyProxySearchService({
    getBaseUrl: () => effectiveXdGatewayBaseUrl(),
    getApiKey: () =>
      getAppCapabilities().canUseCindyGateway ? getProviderSecretStore().get('xd') : null,
    fetchImpl: outboundFetch,
    log,
  });
  return service;
}
