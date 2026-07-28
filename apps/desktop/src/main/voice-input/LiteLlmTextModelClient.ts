import { createHash } from 'node:crypto';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { fetch as undiciFetch, type Agent, type Response as UndiciResponse } from 'undici';

import type { TextModelClient } from '@cindy/voice-input-core';

import { createLogger } from '../logger.js';
import { describeErrorWithCause, markRefinerModelOutputError } from './refinerErrorKind.js';
import { createRefinerHttpDispatcher, resolveRefinerDispatcher } from './refinerHttpDispatcher.js';
import { extractJsonStringFieldSnapshot } from './streamingJson.js';

const log = createLogger('voice-input:refine-model:litellm');

const DISABLE_REFINER_PREWARM = process.env.XDT_VOICE_INPUT_DISABLE_REFINER_PREWARM === '1';
const REFINER_TIMING_ENABLED = process.env.XDT_VOICE_INPUT_REFINER_TIMING === '1';
const MAX_RESPONSE_CHARS = 64_000;

// Own pool for the LiteLLM proxy host (tuning lives in refinerHttpDispatcher.ts).
const refinerDispatcher = createRefinerHttpDispatcher();

export function getLiteLlmRefinerHttpDispatcher(): Agent {
  return refinerDispatcher;
}

/**
 * Best-effort TLS+TCP warmup for LiteLLM-backed refinement. The real request
 * goes to `/v1/chat/completions`; a HEAD against the proxy origin is enough to
 * populate the same undici dispatcher pool and keep the handshake off the
 * stop -> refine critical path.
 */
export async function prewarmLiteLlmRefinerEndpoint(baseUrl: string): Promise<void> {
  if (DISABLE_REFINER_PREWARM) {
    log.debug('litellm refiner endpoint prewarm disabled by env');
    return;
  }
  const target = baseUrl.trim().replace(/\/+$/, '');
  if (!target) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await undiciFetch(target, {
      method: 'HEAD',
      signal: controller.signal,
      // 预热必须与真实请求同一个池(代理生效时是代理池),否则握手白做。
      dispatcher: await resolveRefinerDispatcher(target, refinerDispatcher),
    });
    log.debug('litellm refiner endpoint prewarmed', { status: response.status });
    await response.arrayBuffer().catch(() => undefined);
  } catch (error) {
    log.debug('litellm refiner endpoint prewarm failed (non-fatal)', {
      error: describeErrorWithCause(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export type LiteLlmTokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /**
   * Model name reported by the upstream SSE events. In managed mode the
   * server may have failed over to a different model than requested; usage
   * accounting uses this to attribute tokens to the provider that actually
   * answered.
   */
  servedModel?: string;
};

type LiteLlmTextModelClientOptions = {
  proxyApiKey?: string;
  baseUrl?: string;
  requestTargetProvider?: (options?: {
    forceRefresh?: boolean;
  }) => Promise<{ url: string; authorization: string }>;
  timeoutMs?: number;
  onUsage?: (usage: LiteLlmTokenUsage) => void;
};

type ParsedSseBlock = { data: unknown };

export class LiteLlmTextModelClient implements TextModelClient {
  private readonly proxyApiKey?: string;
  private readonly baseUrl?: string;
  private readonly requestTargetProvider?: (options?: {
    forceRefresh?: boolean;
  }) => Promise<{ url: string; authorization: string }>;
  private readonly timeoutMs: number;
  private readonly onUsage?: (usage: LiteLlmTokenUsage) => void;

  constructor(options: LiteLlmTextModelClientOptions) {
    this.proxyApiKey = options.proxyApiKey;
    this.baseUrl = options.baseUrl;
    this.requestTargetProvider = options.requestTargetProvider;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.onUsage = options.onUsage;
  }

  async requestJson<T>(input: {
    model: string;
    system: string;
    user: unknown;
    schemaName: string;
    promptCacheScope?: string;
    onTextSnapshot?: (text: string) => void;
  }): Promise<T> {
    if (!this.requestTargetProvider && !this.proxyApiKey) throw new Error('Missing XD Gateway API key');
    if (!this.requestTargetProvider && !this.baseUrl) throw new Error('Missing XD Gateway base URL');

    const startedAt = Date.now();
    const systemPromptHash = shortHash(input.system);
    const promptVersion = extractPromptVersion(input.user);
    const promptCacheKey = makePromptCacheKey({
      model: input.model,
      schemaName: input.schemaName,
      promptVersion,
      systemPromptHash,
      scope: input.promptCacheScope,
    });
    log.debug('request', {
      model: input.model,
      schemaName: input.schemaName,
      promptVersion,
      systemPromptHash,
      systemPromptChars: input.system.length,
      promptCacheKey,
    });

    const controller = new AbortController();
    let timeoutReason = 'response';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimeout = (reason: string): void => {
      timeoutReason = reason;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    };
    armIdleTimeout('response headers');
    const sendStart = performance.now();
    let firstByteAt: number | null = null;
    let lastTextSnapshot = '';
    try {
      const requestBody = JSON.stringify({
        model: input.model,
        response_format: { type: 'json_object' },
        prompt_cache_key: promptCacheKey,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: input.system },
          {
            role: 'user',
            content: JSON.stringify({
              schemaName: input.schemaName,
              input: input.user,
            }),
          },
        ],
      });
      const sendRequest = async (forceRefresh = false): Promise<UndiciResponse> => {
        const target = this.requestTargetProvider
          ? await this.requestTargetProvider(forceRefresh ? { forceRefresh: true } : undefined)
          : {
              url: joinProxyPath(this.baseUrl!, '/v1/chat/completions'),
              authorization: `Bearer ${this.proxyApiKey!}`,
            };
        // 代理解析放在看门狗起表之前:它是本机一次解析(带 30s 缓存),不该占用
        // response-headers 的等待预算。
        const dispatcher = await resolveRefinerDispatcher(target.url, refinerDispatcher);
        armIdleTimeout('response headers');
        return undiciFetch(target.url, {
          method: 'POST',
          signal: controller.signal,
          dispatcher,
          headers: {
            Authorization: target.authorization,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: requestBody,
        });
      };
      let response = await sendRequest();
      if (response.status === 401 && this.requestTargetProvider) {
        await response.arrayBuffer().catch(() => undefined);
        response = await sendRequest(true);
      }
      const headersAt = performance.now();
      armIdleTimeout('response body');

      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        const parsed = tryParseJsonObject(raw);
        throw new Error(textModelErrorMessage(parsed, raw, response.status));
      }
      if (!response.body) {
        throw new Error('Empty refinement response body');
      }

      const { content, usageSummary, servedModel, rawChars, bodyAt } = await readStreamingChatCompletion({
        body: response.body,
        onChunk: () => armIdleTimeout('response stream'),
        onFirstByte: () => {
          if (firstByteAt === null) firstByteAt = performance.now();
        },
        onTextContent: (contentSnapshot) => {
          const snapshot = extractJsonTextFieldSnapshot(contentSnapshot);
          if (snapshot && snapshot !== lastTextSnapshot) {
            lastTextSnapshot = snapshot;
            input.onTextSnapshot?.(snapshot);
          }
        },
      });
      const parsedAt = performance.now();
      if (REFINER_TIMING_ENABLED) {
        log.info('refine timing', {
          model: input.model,
          schemaName: input.schemaName,
          sendToHeadersMs: Math.round(headersAt - sendStart),
          headersToFirstByteMs: firstByteAt !== null
            ? Math.round(firstByteAt - headersAt)
            : null,
          headersToBodyMs: Math.round(bodyAt - headersAt),
          bodyToParsedMs: Math.round(parsedAt - bodyAt),
          totalMs: Math.round(parsedAt - sendStart),
          bodyBytes: rawChars,
        });
      }
      log.info('usage', {
        model: input.model,
        schemaName: input.schemaName,
        elapsedMs: Date.now() - startedAt,
        ...usageSummary,
      });
      if (usageSummary.usagePresent) {
        this.onUsage?.({
          promptTokens: usageSummary.promptTokens,
          completionTokens: usageSummary.completionTokens,
          cachedTokens: usageSummary.cachedTokens,
          servedModel,
        });
      }

      // Malformed / empty model output is a model failure, not a channel
      // failure: the fallback layer may retry another model but must not put
      // this provider into failover cooldown.
      if (!content) throw markRefinerModelOutputError(new Error('Empty refinement response'));
      try {
        return parseJsonObject(content) as T;
      } catch (parseError) {
        throw markRefinerModelOutputError(parseError);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Refinement request timed out while waiting for ${timeoutReason}`);
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

async function readStreamingChatCompletion(input: {
  body: NodeReadableStream;
  onChunk: () => void;
  onFirstByte: () => void;
  onTextContent: (content: string) => void;
}): Promise<{
  content: string;
  usageSummary: UsageSummary;
  servedModel: string | undefined;
  rawChars: number;
  bodyAt: number;
}> {
  const reader = input.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let rawChars = 0;
  let usageSummary: UsageSummary = { usagePresent: false };
  let servedModel: string | undefined;
  let streamError: string | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      input.onFirstByte();
      input.onChunk();
      const chunk = decoder.decode(value, { stream: true });
      rawChars += chunk.length;
      if (rawChars > MAX_RESPONSE_CHARS) {
        // Runaway generation: the channel works, the model is flooding.
        throw markRefinerModelOutputError(
          new Error(`LiteLLM refinement response exceeded ${MAX_RESPONSE_CHARS} characters`),
        );
      }
      buf += normalizeSseLineEndings(chunk);
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = parseSseBlock(block);
        if (event) {
          if (!servedModel && isRecord(event.data) && typeof event.data.model === 'string' && event.data.model) {
            servedModel = event.data.model;
          }
          if (isRecord(event.data) && isRecord(event.data.error)) {
            streamError = typeof event.data.error.message === 'string'
              ? event.data.error.message
              : 'LiteLLM refinement stream failed';
          }
          const delta = extractDeltaContent(event.data);
          if (delta) {
            content += delta;
            input.onTextContent(content);
          }
          const chunkUsage = extractUsageSummary(event.data);
          if (chunkUsage.usagePresent) usageSummary = chunkUsage;
        }
        idx = buf.indexOf('\n\n');
      }
    }
    if (buf.trim()) {
      const event = parseSseBlock(buf);
      if (event) {
        if (!servedModel && isRecord(event.data) && typeof event.data.model === 'string' && event.data.model) {
          servedModel = event.data.model;
        }
        const delta = extractDeltaContent(event.data);
        if (delta) {
          content += delta;
          input.onTextContent(content);
        }
        const chunkUsage = extractUsageSummary(event.data);
        if (chunkUsage.usagePresent) usageSummary = chunkUsage;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (streamError) throw new Error(streamError);
  return {
    content: content.trim(),
    usageSummary,
    servedModel,
    rawChars,
    bodyAt: performance.now(),
  };
}

function parseSseBlock(block: string): ParsedSseBlock | null {
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  if (dataStr === '[DONE]') return { data: {} };
  try {
    return { data: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}

function normalizeSseLineEndings(chunk: string): string {
  return chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function extractDeltaContent(chunk: unknown): string {
  if (!isRecord(chunk) || !Array.isArray(chunk.choices)) return '';
  return chunk.choices
    .map((choice) => {
      if (!isRecord(choice)) return '';
      const delta = isRecord(choice.delta) ? choice.delta : null;
      const content = delta?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (typeof part === 'string') return part;
            if (isRecord(part) && typeof part.text === 'string') return part.text;
            return '';
          })
          .join('');
      }
      return '';
    })
    .join('');
}

type UsageSummary = {
  usagePresent: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  usageKeys?: string[];
  promptTokenDetailKeys?: string[];
  inputTokenDetailKeys?: string[];
};

function extractUsageSummary(parsed: unknown): UsageSummary {
  if (!isRecord(parsed) || !isRecord(parsed.usage)) {
    return { usagePresent: false };
  }

  const usage = parsed.usage;
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null;

  return {
    usagePresent: true,
    promptTokens: firstNumber(
      usage.prompt_tokens,
      usage.input_tokens,
    ),
    completionTokens: firstNumber(
      usage.completion_tokens,
      usage.output_tokens,
    ),
    totalTokens: firstNumber(usage.total_tokens),
    cachedTokens: firstNumber(
      promptDetails?.cached_tokens,
      inputDetails?.cached_tokens,
      usage.cached_tokens,
      usage.cache_read_input_tokens,
      usage.cache_read_tokens,
      usage.cacheRead,
    ),
    cacheCreationTokens: firstNumber(
      promptDetails?.cache_creation_tokens,
      inputDetails?.cache_creation_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_creation_tokens,
      usage.cacheCreate,
    ),
    usageKeys: Object.keys(usage).sort(),
    promptTokenDetailKeys: promptDetails ? Object.keys(promptDetails).sort() : undefined,
    inputTokenDetailKeys: inputDetails ? Object.keys(inputDetails).sort() : undefined,
  };
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function extractPromptVersion(user: unknown): string | undefined {
  if (!isRecord(user)) return undefined;
  return typeof user.promptVersion === 'string' ? user.promptVersion : undefined;
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 20);
}

/**
 * Managed-mode warmup helper: derives the exact prompt_cache_key that
 * requestJson() will send for the refinement with the same inputs — the
 * upstream cache node is routed by this key, so any divergence would warm the
 * wrong shard.
 */
export function makeRefinerPromptCacheKey(input: {
  model: string;
  schemaName: string;
  promptVersion?: string;
  system: string;
  scope?: string;
}): string {
  return makePromptCacheKey({
    model: input.model,
    schemaName: input.schemaName,
    promptVersion: input.promptVersion,
    systemPromptHash: shortHash(input.system),
    scope: input.scope,
  });
}

function makePromptCacheKey(input: {
  model: string;
  schemaName: string;
  promptVersion?: string;
  systemPromptHash: string;
  scope?: string;
}): string {
  const scopeHash = shortHash(input.scope?.trim() || 'default');
  return `xdt:${input.schemaName}:${shortHash([
    input.model,
    input.promptVersion ?? '',
    input.systemPromptHash,
    scopeHash,
  ].join('\n'))}`;
}

const extractJsonTextFieldSnapshot = (text: string): string | null =>
  extractJsonStringFieldSnapshot(text, 'text');

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Invalid JSON response: ${trimmed.slice(0, 160)}`);
    return JSON.parse(match[0]);
  }
}

function tryParseJsonObject(text: string): unknown {
  try {
    return parseJsonObject(text);
  } catch {
    return null;
  }
}

function textModelErrorMessage(parsed: unknown, raw: string, status: number): string {
  if (isRecord(parsed)) {
    const detail = parsed.detail;
    if (typeof detail === 'string') return detail;
    const error = parsed.error;
    if (isRecord(error) && typeof error.message === 'string') return error.message;
    if (typeof parsed.message === 'string') return parsed.message;
  }
  return raw.trim() || `Refinement failed with HTTP ${status}`;
}

function joinProxyPath(baseUrl: string, endpointPath: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/${endpointPath.trim().replace(/^\/+/, '')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
