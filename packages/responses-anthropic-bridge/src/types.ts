import type { ServerResponse } from 'node:http';

export interface ResponsesAnthropicLogger {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ResponsesAnthropicRequestContext {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ResponsesAnthropicErrorInfo {
  status: number;
  body: string;
  requestHeaders: Readonly<Record<string, string>>;
}

export interface ResponsesAnthropicAuthRetryInfo {
  status: 401 | 403;
  body: string;
  requestHeaders: Readonly<Record<string, string>>;
}

export interface AnthropicImageCodecInput {
  data: string;
  mediaType: string;
  maxEdge: number;
  qualities: readonly number[];
  hardCap: number;
}

export interface AnthropicImageCodecOutput {
  data: string;
  mediaType: string;
}

/**
 * Host-owned image codec. The bridge owns limit policy and ordering, while the host
 * supplies the native decoder/encoder available in its runtime.
 */
export interface AnthropicImageCodec {
  normalize(input: AnthropicImageCodecInput): Promise<AnthropicImageCodecOutput | null>;
}

export interface ResponsesAnthropicProviderConfig {
  /** Anthropic-compatible base URL; the default endpoint is `/v1/messages`. */
  upstreamBase: string;
  /** Optional exact endpoint path, for gateways that do not use `/v1/messages`. */
  requestPath?: string;
  /**
   * Request-policy mode only: API keys use the plain Messages contract, while
   * Claude.ai OAuth needs Claude Code policy. Credential refresh is controlled
   * independently by refreshHeaders.
   */
  authMode?: 'api-key' | 'oauth';
  /** Provider-owned headers. Never pass Codex/OpenAI OAuth headers here. */
  buildHeaders: () => Promise<Record<string, string>>;
  /** One-shot provider credential refresh hook invoked only after an upstream 401/403. */
  refreshHeaders?: (
    info: ResponsesAnthropicAuthRetryInfo,
  ) => Promise<Record<string, string> | null>;
  /** Rewrite the Responses wire model before sending it upstream. */
  rewriteModel?: (model: string) => string;
  /** Default max_tokens because Anthropic requires it even when Responses omits it. */
  defaultMaxTokens?: number;
  /** Whether this model family accepts `thinking: {type:"adaptive"}`. */
  supportsAdaptiveThinking?: (model: string) => boolean;
  /** Whether the upstream accepts Anthropic thinking fields at all. */
  supportsThinking?: (model: string) => boolean;
  /** Disable prompt cache breakpoints for a provider that does not implement them. */
  promptCaching?: boolean;
  /** Native Anthropic endpoints support top-level automatic prompt caching. */
  automaticPromptCaching?: boolean;
  /** Preserve Responses `strict` on tools only when the upstream Messages schema supports it. */
  strictTools?: boolean;
  /** Optional native image codec; limits still apply when no codec is available. */
  imageCodec?: AnthropicImageCodec;
  /** Called after a non-2xx response, before the translated error is returned. */
  onUpstreamError?: (info: ResponsesAnthropicErrorInfo) => void | Promise<void>;
  /**
   * Called once for the final upstream response — success or not — before the body
   * is read or translated. Intermediate responses consumed by an internal retry
   * (401/403 credential refresh, 413 image downscale) are not reported.
   *
   * Provider-agnostic response metadata only: the bridge does not interpret these
   * headers. Best effort — the call is fire-and-forget and never blocks or fails
   * the response, so a consumer must not rely on it for correctness.
   */
  onUpstreamResponse?: (info: ResponsesAnthropicResponseInfo) => void | Promise<void>;
}

export interface ResponsesAnthropicResponseInfo {
  status: number;
  /** Final upstream response headers. Iterating a Fetch `Headers` lowercases names. */
  responseHeaders: Headers;
  /** Provider-owned request headers actually sent upstream for this attempt. */
  requestHeaders: Readonly<Record<string, string>>;
}

export interface ResponsesAnthropicHandleArgs {
  parsedBody: unknown;
  ctx: ResponsesAnthropicRequestContext;
  res: ServerResponse;
}

export interface ResponsesAnthropicHandler {
  handle(args: ResponsesAnthropicHandleArgs): Promise<void>;
}

export interface ResponsesRequest {
  model: string;
  instructions?: string | unknown[];
  input?: string | unknown[];
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  reasoning?: { effort?: string; [key: string]: unknown };
  stream?: boolean;
  prompt_cache_key?: string;
  temperature?: number;
  top_p?: number;
  stop?: string | string[] | null;
  [key: string]: unknown;
}

export interface AnthropicRequest {
  model: string;
  system?: Array<{ type: 'text'; text: string; cache_control?: CacheControl }>;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  tools?: unknown[];
  tool_choice?: unknown;
  max_tokens: number;
  stream: boolean;
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' } | { type: 'disabled' };
  output_config?: { effort: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  cache_control?: CacheControl;
  [key: string]: unknown;
}

export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

export type ToolCallKind = 'function' | 'namespace' | 'custom' | 'tool_search';

export interface ToolCallMapping {
  wireName: string;
  name: string;
  namespace?: string;
  kind: ToolCallKind;
}

export interface ToolContext {
  byWireName: ReadonlyMap<string, ToolCallMapping>;
  byResponseName: ReadonlyMap<string, ToolCallMapping>;
}

export class UnsupportedResponsesFeatureError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(`Responses feature is not supported by the Anthropic bridge: ${feature}`);
    this.name = 'UnsupportedResponsesFeatureError';
    this.feature = feature;
  }
}

export class InvalidResponsesRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidResponsesRequestError';
  }
}
