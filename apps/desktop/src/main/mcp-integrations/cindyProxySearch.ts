import { getAppCapabilities } from '../appCapabilities.js';
import { createLogger } from '../logger.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { reportCindyGatewayKeyRejected } from '../model-access/gatewayKeyRejection.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import {
  matchesDeterministicUsageExhaustionText,
  redactSensitiveText,
} from '@cindy/maker-shared/error-redaction';

export const CINDY_SEARCH_MODEL_NAME = 'cindy/web-search';
const CINDY_SEARCH_WEB_TOOL_TYPE = 'web_search_20250305';
const CINDY_SEARCH_MAX_TOKENS = 2_048;
const CINDY_SEARCH_TIMEOUT_MS = 30_000;
const CINDY_SEARCH_MAX_SNIPPET_CHARS = 500;

/**
 * 搜索后端的结果只带标题、链接与加密正文，没有 cited_text / citations，摘要会全空；
 * 后端模型也会无视 max_uses 再搜一次。让模型只搜一次，并为前 limit 条结果各写一行
 * `<url> | 摘要`，由 parseSearchResponse 按链接回填 snippet。
 */
function buildSearchSystemPrompt(limit: number): string {
  return [
    'You are a web search backend. Call web_search exactly once with the user query, then stop searching.',
    `After the search, output one line for each of the first ${limit} results, in result order, formatted exactly as:`,
    '<url> | <one or two sentences stating what that page says about the query>',
    'Copy each URL verbatim from the search result.',
    // 只写「用查询的语言」时，后端模型会对英文查询输出中文摘要；写明映射后才稳定。
    'Write each summary in the same language as the user query (English query -> English, Chinese query -> Chinese).',
    'Output nothing else.',
  ].join('\n');
}

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
  /** 网关以 401 拒绝本次请求携带的 Cindy AI Key 时调用,入参为该 Key。 */
  onKeyRejected?(apiKey: string): void;
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
  // 余额耗尽(#4024):网关的预算闸用 HTTP 429 + `ExceededBudget` 正文拒绝,与瞬时限流
  // 共用状态码。先按仓库共享的严格判定(与对话 Error Banner / 终端限流重试同一 SSoT)
  // 识别明确的额度耗尽,再落普通 429 —— 否则用户会被引导「稍后再试」而永远不会恢复。
  // 429 只认严格信号:宽松措辞(quota/credit/balance…)留给非 429 状态,避免把
  // 「rate limit exceeded, credits refill soon」这类瞬时限流误判成需要充值。
  const deterministicExhaustion = matchesDeterministicUsageExhaustionText(body.slice(0, 1024));
  const looksLikeQuota =
    status === 429
      ? deterministicExhaustion
      : status === 402 ||
        deterministicExhaustion ||
        /(?:quota|credit|balance|insufficient|exhausted|spend limit)/.test(normalized);
  if (looksLikeQuota) {
    return {
      errorCode: 'QUOTA_EXHAUSTED',
      message: 'Cindy AI 余额不足，请充值后再试，或在插件设置中改用自己的搜索渠道',
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

const DIGEST_TOKEN_MAX_CHARS = 64;
const DIGEST_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** 结构化诊断摘要:只收允许名单里的字段,绝不把任意上游正文落盘。 */
export interface SearchResponseBodyDigest {
  /** 正文是否为 JSON 对象;非 JSON 只记长度,不记内容。 */
  json: boolean;
  /** 原始正文字符数(用于判断是否被网关截断/是否为空)。 */
  length: number;
  /** 顶层 `error`(字符串或对象的 `code`/`type`)——仅当形如 `ExceededBudget` 的短标识才记录。 */
  error?: string;
  /** 顶层 / `error.` 下的 `code`、`type`,同样只收短标识。 */
  code?: string;
  type?: string;
  /** 网关预算闸附带的数值,用于复盘「预算闸拒绝」而非「真限流」。 */
  spend?: number;
  budget?: number;
}

function digestToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!DIGEST_TOKEN_PATTERN.test(trimmed)) return undefined;
  // 标识形态本不该含凭证,再过一遍共享脱敏兜底(例如 `key:...` 形态)。
  return redactSensitiveText(trimmed).slice(0, DIGEST_TOKEN_MAX_CHARS);
}

function digestNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 非 2xx 响应体的诊断摘要(#4024):区分「预算闸拒绝」与「真限流」靠的是正文,但上游
 * 正文可能回显 query、以非标准字段携带凭证或含其他敏感内容,通用脱敏器不保证识别 ——
 * 因此不记任意文本,只按允许名单抽取短标识与数值,其余只记长度。
 */
function responseBodyDigest(body: string): SearchResponseBodyDigest {
  const digest: SearchResponseBodyDigest = { json: false, length: body.length };
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return digest;
  }
  if (!isRecord(decoded)) return digest;
  digest.json = true;
  const errorField = decoded.error;
  const errorRecord = isRecord(errorField) ? errorField : null;
  const error =
    digestToken(errorField) ?? digestToken(errorRecord?.code) ?? digestToken(errorRecord?.type);
  const code = digestToken(decoded.code) ?? digestToken(errorRecord?.code);
  const type = digestToken(decoded.type) ?? digestToken(errorRecord?.type);
  const spend = digestNumber(decoded.spend) ?? digestNumber(errorRecord?.spend);
  const budget = digestNumber(decoded.budget) ?? digestNumber(errorRecord?.budget);
  if (error !== undefined) digest.error = error;
  if (code !== undefined) digest.code = code;
  if (type !== undefined) digest.type = type;
  if (spend !== undefined) digest.spend = spend;
  if (budget !== undefined) digest.budget = budget;
  return digest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizedHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // 后端会给链接追加 `#1` 这类序号锚点、把换行编码进路径末尾，同一页面因此去重失败。
    if (/^#\d+$/.test(url.hash)) url.hash = '';
    url.pathname = url.pathname.replace(/(?:%0A|%0D|%09|%20)+$/i, '');
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * 模型复述链接时可能改写协议或末尾斜杠，回填摘要只忽略这两项差异；端口、查询串与
 * 有意义的锚点(`#install` / `#upgrade`)标识不同的页面或章节，必须保留。序号锚点
 * 已在 normalizedHttpUrl 去掉。
 */
function sourceMatchKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function fallbackTitle(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// 只剥真实的 HTML 标签：带属性的开标签，或常见标签名的开/闭/自闭标签。
// `<T>`、`<K, V>` 这类泛型/代码文本不在其中，必须保留。
const HTML_TAG_PATTERN = new RegExp(
  '<[a-z][a-z0-9-]*\\s+[^<>]*=[^<>]*>|' +
    '</?(?:p|div|span|a|b|i|u|em|strong|br|hr|img|center|h[1-6]|ul|ol|li|table|tr|td|th|' +
    'section|article|header|footer|nav|main|font|small|code|pre|html|head|body|title|meta|link|script|style)' +
    '(?:\\s[^<>]*)?/?>',
  'gi',
);

function cleanTitle(value: unknown, url: string): string {
  // 抓取到的标题偶尔是页面里的 HTML 片段(如 `<p align="center">`)。
  const title =
    typeof value === 'string'
      ? value.replace(HTML_TAG_PATTERN, ' ').replace(/\s+/g, ' ').trim()
      : '';
  return title || fallbackTitle(url);
}

const SNIPPET_LINE_PATTERN =
  /^\s*(?:[-*>]|\d+[.)]|\[\d+\])?\s*<?(https?:\/\/[^\s|<>]+)>?\s*\|\s*(.+?)\s*$/;

/** 解析 buildSearchSystemPrompt 要求的 `<url> | 摘要` 行;只回填已有结果，不据此新增来源。 */
function collectSnippetLines(text: string, into: Map<string, string>): void {
  for (const line of text.split('\n')) {
    const match = SNIPPET_LINE_PATTERN.exec(line);
    if (!match) continue;
    const url = normalizedHttpUrl(match[1]);
    if (!url) continue;
    const key = sourceMatchKey(url);
    if (!into.has(key)) into.set(key, match[2].slice(0, CINDY_SEARCH_MAX_SNIPPET_CHARS));
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
  const title = cleanTitle(value.title, url);
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

  // 后端在一次响应里可能先给出结果、再因后续搜索报错(如 max_uses_exceeded)。
  // 工具级错误只在一条结果都没有时才代表本次搜索失败。
  let toolError: { errorCode: unknown } | null = null;
  const snippetLines = new Map<string, string>();

  for (const block of raw.content) {
    if (!isRecord(block)) continue;

    if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content)) {
        if (block.content.length > 0) sawCandidate = true;
        for (const item of block.content) {
          if (!isRecord(item)) continue;
          if (item.type === 'web_search_tool_result_error') {
            toolError ??= { errorCode: item.error_code };
            continue;
          }
          if (item.type !== 'web_search_result') continue;
          const source = sourceFromRecord(item);
          if (source) mergeSource(source);
        }
      } else if (isRecord(block.content) && block.content.type === 'web_search_tool_result_error') {
        toolError ??= { errorCode: block.content.error_code };
      } else {
        return invalidSearchResponse();
      }
    }

    if (block.type === 'text') {
      if (typeof block.text === 'string') collectSnippetLines(block.text, snippetLines);
      if (Array.isArray(block.citations)) {
        if (block.citations.length > 0) sawCandidate = true;
        for (const citation of block.citations) {
          if (!isRecord(citation)) continue;
          const source = sourceFromRecord(citation);
          if (source) mergeSource(source);
        }
      }
    }
  }

  if (sources.size === 0) {
    if (toolError) return searchToolFailure(toolError.errorCode);
    if (sawCandidate) return invalidSearchResponse();
  }
  const results = Array.from(sources.values()).slice(0, limit);
  for (const result of results) {
    if (!result.snippet) result.snippet = snippetLines.get(sourceMatchKey(result.url)) ?? '';
  }
  return { ok: true, results };
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
            system: buildSearchSystemPrompt(limit),
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
      // 拿到状态码就上报,不依赖后续正文读取成功(读正文中断时也不能漏报)。
      if (response.status === 401) deps.onKeyRejected?.(apiKey);
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
          // 允许名单式的结构化正文摘要,只进本机诊断日志(不回传插件 / 用户):
          // 区分「预算闸拒绝」与「真限流」靠的正是正文,此前日志只有状态码无从复盘(#4024)。
          bodyDigest: responseBodyDigest(body),
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
    onKeyRejected: reportCindyGatewayKeyRejected,
    log,
  });
  return service;
}
