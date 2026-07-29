import { createHash } from 'node:crypto';

import { fetch as undiciFetch, type Agent } from 'undici';

import type { TextModelClient } from '@cindy/voice-input-core';

import { createLogger } from '../logger.js';
import { describeErrorWithCause, markRefinerModelOutputError } from './refinerErrorKind.js';
import { createRefinerHttpDispatcher, resolveRefinerDispatcher } from './refinerHttpDispatcher.js';
import { extractJsonStringFieldSnapshot } from './streamingJson.js';

const log = createLogger('voice-input:refine-model');

// This is the Codex/ChatGPT OAuth transport, not the public OpenAI Platform
// Responses API. It matches the same product boundary as OpenClaw's
// `openai-codex-responses` provider: convenient while the user is already
// connected to Codex, but more private-contract than `api.openai.com/v1`.
// Keep public OpenAI/LiteLLM Responses clients as the long-term stable path.
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_PREWARM_URL = 'https://chatgpt.com';
const MAX_ACCUMULATED_CHARS = 64_000;
const DISABLE_PREWARM = process.env.XDT_VOICE_INPUT_DISABLE_REFINER_PREWARM === '1';
const REFINER_TIMING_ENABLED = process.env.XDT_VOICE_INPUT_REFINER_TIMING === '1';
// Mirror codex-rs's default `originator`. The Codex backend tags requests by
// this string for enterprise telemetry / quota routing; using the canonical
// CLI identifier keeps our refine calls on the same code path the backend has
// already vetted for Cloudflare fingerprinting.
const ORIGINATOR = 'codex_cli_rs';
const USER_AGENT = `codex_cli_rs/xdt-maker (${process.platform}; ${process.arch})`;

/**
 * Shared connection pool for codex responses calls (tuning lives in
 * refinerHttpDispatcher.ts). Also serves the prewarm HEAD so that warm-up
 * actually populates the pool the first real refine call will draw from.
 */
const codexResponsesDispatcher = createRefinerHttpDispatcher();

export function getCodexResponsesHttpDispatcher(): Agent {
  return codexResponsesDispatcher;
}

/**
 * Best-effort TLS+TCP warmup for the Codex backend host. Issues a HEAD to
 * `chatgpt.com` (NOT the /backend-api/codex/responses path itself — that
 * endpoint reacts to HEAD with cookie/auth checks and is more likely to be
 * rate limited than a plain origin probe). The handshake is the only thing
 * this call exists to do; errors are swallowed.
 */
export async function prewarmCodexResponsesEndpoint(): Promise<void> {
  if (DISABLE_PREWARM) {
    log.debug('codex responses prewarm disabled by env');
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await undiciFetch(DEFAULT_PREWARM_URL, {
      method: 'HEAD',
      signal: controller.signal,
      // 预热必须与真实请求同一个池,否则握手白做(代理生效时是代理池)。
      dispatcher: await resolveRefinerDispatcher(DEFAULT_PREWARM_URL, codexResponsesDispatcher),
    });
    log.debug('codex responses endpoint prewarmed', { status: response.status });
    await response.arrayBuffer().catch(() => undefined);
  } catch (error) {
    log.debug('codex responses prewarm failed (non-fatal)', {
      error: describeErrorWithCause(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export type CodexTokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
};

type CodexResponsesTextModelClientOptions = {
  /**
   * Resolves the Codex OAuth access token at request time. Codex tokens
   * refresh roughly hourly; calling per-request lets the adapter rotate them
   * transparently rather than caching a stale value.
   */
  accessTokenProvider: () => Promise<string | null>;
  /**
   * Resolves the ChatGPT account id. Optional — if null is returned, the
   * header is omitted. Codex CLI behaves the same way on single-account
   * logins, so this is safe.
   */
  accountIdProvider: () => Promise<string | null>;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Called once per successful request with normalized token usage. Wired by
   * the host to push usage telemetry to the renderer.
   */
  onUsage?: (usage: CodexTokenUsage) => void;
  /**
   * Codex OAuth expiration is an auth-state change, not a transient model
   * failure. The voice-input controller may fall back to raw ASR text after
   * refine rejects, so the host must be told explicitly to surface the shared
   * "重新登录 Codex" flow.
   */
  onAuthInvalidated?: (reason: string) => void;
};

/**
 * Minimal Responses-API JSON client backed by the Codex backend.
 *
 * Speaks SSE end-to-end (the only mode the backend exposes), accumulating
 * `response.output_text.delta` frames into one string and JSON-parsing the
 * result at the end. The final JSON parse is still the accept/reject boundary;
 * partial text snapshots are best-effort UI previews extracted from the
 * streaming JSON `text` field and must never be treated as committed output.
 *
 * Stays in Electron main so the renderer never sees the OAuth token.
 */
export class CodexResponsesTextModelClient implements TextModelClient {
  private readonly accessTokenProvider: () => Promise<string | null>;
  private readonly accountIdProvider: () => Promise<string | null>;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly onUsage?: (usage: CodexTokenUsage) => void;
  private readonly onAuthInvalidated?: (reason: string) => void;
  private authInvalidationNotified = false;

  constructor(options: CodexResponsesTextModelClientOptions) {
    this.accessTokenProvider = options.accessTokenProvider;
    this.accountIdProvider = options.accountIdProvider;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.onUsage = options.onUsage;
    this.onAuthInvalidated = options.onAuthInvalidated;
  }

  async requestJson<T>(input: {
    model: string;
    system: string;
    user: unknown;
    schemaName: string;
    promptCacheScope?: string;
    onTextSnapshot?: (text: string) => void;
  }): Promise<T> {
    const [accessToken, accountId] = await Promise.all([
      this.accessTokenProvider(),
      this.accountIdProvider(),
    ]);
    if (!accessToken) throw new Error('Missing Codex access token');

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
      accountIdPresent: Boolean(accountId),
    });

    // Responses API expects a structured `input` array with content parts.
    // We carry the whole prior `user` payload as a single input_text part so
    // refine prompts that depend on field order (cache prefix preservation
    // etc.) keep working unchanged.
    const userPayload = JSON.stringify({
      schemaName: input.schemaName,
      input: input.user,
    });
    const body = {
      model: input.model,
      instructions: input.system,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: userPayload }],
        },
      ],
      stream: true,
      store: false,
      prompt_cache_key: promptCacheKey,
    };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'OpenAI-Beta': 'responses=experimental',
      originator: ORIGINATOR,
      'User-Agent': USER_AGENT,
    };
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;

    const controller = new AbortController();
    let timeoutReason = 'response';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimeout = (reason: string): void => {
      timeoutReason = reason;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    };
    // 代理解析放在看门狗与 timing 起表之前:它是本机一次解析(带 30s 缓存),
    // 不该算进 response-headers 预算,也不该污染 send 耗时。
    const dispatcher = await resolveRefinerDispatcher(this.baseUrl, codexResponsesDispatcher);
    armIdleTimeout('response headers');
    const sendStart = performance.now();
    let firstByteAt: number | null = null;
    let lastTextSnapshot = '';
    try {
      const response = await undiciFetch(this.baseUrl, {
        method: 'POST',
        signal: controller.signal,
        dispatcher,
        headers,
        body: JSON.stringify(body),
      });
      const headersAt = performance.now();
      armIdleTimeout('response body');
      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        const parsed = tryParseJsonObject(raw);
        const message = textModelErrorMessage(parsed, raw, response.status);
        const authInvalidationReason = this.notifyAuthInvalidatedFromError(message, response.status, parsed);
        throw new Error(authInvalidationReason ? `${authInvalidationReason}: ${message}` : message);
      }
      if (!response.body) {
        throw new Error('Codex responses returned empty body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let accumulated = '';
      let usage: CodexTokenUsage | null = null;
      let usageKeys: string[] | undefined;
      let streamErr: string | null = null;
      let streamErrData: unknown = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (firstByteAt === null && value) firstByteAt = performance.now();
          if (done) break;
          armIdleTimeout('response stream');
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf('\n\n');
          while (idx >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const event = parseSseBlock(block);
            if (event) {
              if (event.type === 'response.output_text.delta') {
                const delta = isRecord(event.data) && typeof event.data.delta === 'string'
                  ? event.data.delta
                  : '';
                if (accumulated.length + delta.length > MAX_ACCUMULATED_CHARS) {
                  // Runaway generation: the channel works, the model is flooding.
                  throw markRefinerModelOutputError(
                    new Error(`Codex responses output exceeded ${MAX_ACCUMULATED_CHARS} characters`),
                  );
                }
                accumulated += delta;
                const snapshot = extractJsonTextFieldSnapshot(accumulated);
                if (snapshot && snapshot !== lastTextSnapshot) {
                  lastTextSnapshot = snapshot;
                  input.onTextSnapshot?.(snapshot);
                }
              } else if (event.type === 'response.completed') {
                const respObj = isRecord(event.data) && isRecord(event.data.response)
                  ? event.data.response
                  : null;
                if (respObj) {
                  const extracted = extractResponsesUsage(respObj.usage);
                  if (extracted) {
                    usage = extracted.usage;
                    usageKeys = extracted.usageKeys;
                  }
                }
              } else if (event.type === 'response.failed' || event.type === 'error') {
                const errSource = isRecord(event.data) && isRecord(event.data.response)
                  ? event.data.response.error
                  : isRecord(event.data) ? event.data.error : null;
                streamErr = isRecord(errSource) && typeof errSource.message === 'string'
                  ? errSource.message
                  : 'Codex responses stream failed';
                streamErrData = event.data;
              }
            }
            idx = buf.indexOf('\n\n');
          }
        }
      } finally {
        // Always release the reader so the underlying connection can be
        // returned to the keepalive pool, even on parse errors below.
        reader.releaseLock();
      }
      const bodyAt = performance.now();

      if (streamErr) {
        const authInvalidationReason = this.notifyAuthInvalidatedFromError(streamErr, response.status, streamErrData);
        throw new Error(authInvalidationReason ? `${authInvalidationReason}: ${streamErr}` : streamErr);
      }
      // Malformed model output is a model failure, not a channel failure: the
      // fallback layer may retry another model but must not put this provider
      // into failover cooldown.
      let parsed: unknown;
      try {
        parsed = parseJsonObject(accumulated);
      } catch (parseError) {
        throw markRefinerModelOutputError(parseError);
      }
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
          accumulatedChars: accumulated.length,
        });
      }
      log.info('usage', {
        model: input.model,
        schemaName: input.schemaName,
        elapsedMs: Date.now() - startedAt,
        usagePresent: Boolean(usage),
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        cachedTokens: usage?.cachedTokens,
        usageKeys,
      });
      if (usage) {
        this.onUsage?.(usage);
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Refinement request timed out while waiting for ${timeoutReason}`);
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private notifyAuthInvalidated(reason: string): void {
    if (this.authInvalidationNotified) return;
    this.authInvalidationNotified = true;
    this.onAuthInvalidated?.(reason);
  }

  private notifyAuthInvalidatedFromError(
    message: string,
    status: number,
    parsed: unknown,
  ): string | null {
    const reason = detectCodexAuthInvalidationReason(message, status, parsed);
    if (reason) this.notifyAuthInvalidated(reason);
    return reason;
  }
}

function detectCodexAuthInvalidationReason(
  message: string,
  status?: number,
  parsed?: unknown,
): string | null {
  const code = extractErrorCode(parsed);
  if (code === 'app_session_terminated') return 'app_session_terminated';
  if (code === 'token_invalidated') return 'token_invalidated';

  if (/app_session_terminated|Your session has ended/i.test(message)) {
    return 'app_session_terminated';
  }
  if (/token_invalidated|authentication token has been invalidated|Missing Codex access token/i.test(message)) {
    return 'token_invalidated';
  }
  if (/refresh token was already used|refresh_token.*already used/i.test(message)) {
    return 'refresh_token_reused';
  }
  // Plain 401/403 from this Codex backend means the OAuth credential is no
  // longer usable; unlike network errors, retrying cannot recover it.
  if ((status === 401 || status === 403) && /unauthori[sz]ed|forbidden|auth|token|credential|login/i.test(message)) {
    return 'token_invalidated';
  }
  return null;
}

function extractErrorCode(parsed: unknown): string | null {
  if (!isRecord(parsed)) return null;
  if (typeof parsed.code === 'string') return parsed.code;
  const error = parsed.error;
  if (isRecord(error) && typeof error.code === 'string') return error.code;
  if (isRecord(error) && typeof error.type === 'string') return error.type;
  const response = parsed.response;
  if (isRecord(response)) {
    const responseError = response.error;
    if (isRecord(responseError) && typeof responseError.code === 'string') return responseError.code;
    if (isRecord(responseError) && typeof responseError.type === 'string') return responseError.type;
  }
  return null;
}

type ParsedSseBlock = { type: string; data: unknown };

function parseSseBlock(block: string): ParsedSseBlock | null {
  let eventType = '';
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(':')) continue; // SSE comment
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // SSE spec: strip a single leading space after the colon.
      const v = line.slice(5);
      dataLines.push(v.startsWith(' ') ? v.slice(1) : v);
    }
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  if (dataStr === '[DONE]') return { type: 'done', data: {} };
  try {
    return { type: eventType, data: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}

function extractResponsesUsage(usage: unknown): { usage: CodexTokenUsage; usageKeys: string[] } | null {
  if (!isRecord(usage)) return null;
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null;
  return {
    usage: {
      promptTokens: firstNumber(usage.input_tokens, usage.prompt_tokens),
      completionTokens: firstNumber(usage.output_tokens, usage.completion_tokens),
      cachedTokens: firstNumber(
        details?.cached_tokens,
        usage.cached_tokens,
        usage.cache_read_input_tokens,
      ),
    },
    usageKeys: Object.keys(usage).sort(),
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

function makePromptCacheKey(input: {
  model: string;
  schemaName: string;
  promptVersion?: string;
  systemPromptHash: string;
  scope?: string;
}): string {
  // Same shape as the LiteLLM-bound client used so prompt cache observability
  // (logs, downstream dashboards) is identical across the migration. The
  // Responses API also reads `prompt_cache_key` as a routing hint.
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
  if (!trimmed) throw new Error('Empty refinement response');
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
    if (typeof detail === 'string') return `Codex responses HTTP ${status}: ${detail}`;
    const error = parsed.error;
    if (isRecord(error) && typeof error.message === 'string') {
      return `Codex responses HTTP ${status}: ${error.message}`;
    }
    if (typeof parsed.message === 'string') return `Codex responses HTTP ${status}: ${parsed.message}`;
  }
  const body = raw.trim();
  return body
    ? `Codex responses HTTP ${status}: ${body.slice(0, 240)}`
    : `Codex responses HTTP ${status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
