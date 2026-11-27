import { app, net } from 'electron';
import { request as httpRequest } from 'node:http';
import * as https from 'node:https';

export const CHAT_REQUEST_TIMEOUT_MS = 15_000;
export const CHAT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

export interface ChatTransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: Buffer;
}

export type ChatFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ChatHttpRequestOptions {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: ChatFetchLike;
  useNetFetch?: boolean;
}

const TRANSIENT_RESET_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_HTTP2_PROTOCOL_ERROR',
  'ERR_HTTP2_PING_FAILED',
  'ERR_HTTP2_SERVER_REFUSED_STREAM',
  'ERR_SOCKET_NOT_CONNECTED',
]);

const TRANSIENT_RESET_PATTERN = /\b(ECONNRESET|EPIPE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_HTTP2_PROTOCOL_ERROR|ERR_HTTP2_PING_FAILED|ERR_HTTP2_SERVER_REFUSED_STREAM|ERR_SOCKET_NOT_CONNECTED)\b|socket hang up/i;
const CHROMIUM_NET_CODE_PATTERN = /\bnet::(ERR_[A-Z0-9_]{1,56})\b/;

// Shared keep-alive agent for the Node https fallback path (when running outside Electron
// or before app readiness). Guarded via Object.keys so Vitest's strict mock proxy for
// `node:https` ({ request }) does not throw on missing `Agent` export.
const keepAliveHttpsAgent = (() => {
  try {
    if (!Object.keys(https).includes('Agent') || typeof https.Agent !== 'function') return undefined;
    return new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 16 });
  } catch {
    return undefined;
  }
})();

/**
 * Extracts a safe uppercase Chromium `net::ERR_*` diagnostic code when Electron's
 * `net.fetch` surfaces a transport error without a structured `.code` property.
 */
export function normalizeNetFetchError(error: unknown, timedOut: boolean): Error {
  if (timedOut) return new Error('REQUEST_TIMEOUT');
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return new Error('REQUEST_TIMEOUT');
    const existingCode = (error as { code?: unknown }).code;
    if (typeof existingCode === 'string' && existingCode.length > 0) return error;
    const match = CHROMIUM_NET_CODE_PATTERN.exec(error.message);
    if (match?.[1]) {
      return Object.assign(new Error(match[1]), { code: match[1], cause: error });
    }
    return error;
  }
  return new Error(String(error));
}

/**
 * True only for transient socket/HTTP2 stream resets that occur before a response
 * completes, making a single retry safe for idempotent GET requests.
 */
export function isTransientGetTransportReset(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 3 && cursor && typeof cursor === 'object'; depth += 1) {
    const candidate = cursor as { code?: unknown; message?: unknown; status?: unknown; cause?: unknown };
    if (typeof candidate.status === 'number') return false;
    if (typeof candidate.code === 'string' && TRANSIENT_RESET_CODES.has(candidate.code)) return true;
    if (typeof candidate.message === 'string') {
      if (candidate.message === 'REQUEST_TIMEOUT' || candidate.message === 'OWNER_CHANGED'
        || candidate.message === 'RESPONSE_TOO_LARGE' || candidate.message === 'CHAT_REDIRECT_REFUSED') {
        return false;
      }
      if (TRANSIENT_RESET_PATTERN.test(candidate.message)) return true;
    }
    cursor = candidate.cause;
  }
  return false;
}

/**
 * Electron's `net.fetch` runs on Chromium's network service: HTTP/2 multiplexing over
 * one pooled connection, TLS session resumption, and automatic OS proxy support.
 */
export function shouldUseElectronNetFetch(): boolean {
  if (!process.versions?.electron) return false;
  if (typeof net?.fetch !== 'function') return false;
  if (typeof app?.isReady === 'function' && !app.isReady()) return false;
  return true;
}

async function readResponseWithLimit(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Buffer> {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        controller.abort();
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

async function performWithNetFetch(
  fetchImpl: ChatFetchLike,
  options: ChatHttpRequestOptions,
): Promise<ChatTransportResponse> {
  const timeoutMs = options.timeoutMs ?? CHAT_REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? CHAT_RESPONSE_MAX_BYTES;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('REQUEST_TIMEOUT'));
      reject(new Error('REQUEST_TIMEOUT'));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const response = await Promise.race([
      fetchImpl(options.url.href, {
        method: options.method,
        headers: options.headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        redirect: 'manual',
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel?.().catch(() => undefined);
      throw new Error('CHAT_REDIRECT_REFUSED');
    }
    const body = await Promise.race([
      readResponseWithLimit(response, maxBytes, controller),
      timeoutPromise,
    ]);
    return {
      status: response.status,
      headers: { get: name => response.headers.get(name) },
      body,
    };
  } catch (error) {
    throw normalizeNetFetchError(error, timedOut);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function performWithNodeHttp(options: ChatHttpRequestOptions): Promise<ChatTransportResponse> {
  const timeoutMs = options.timeoutMs ?? CHAT_REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? CHAT_RESPONSE_MAX_BYTES;
  return new Promise<ChatTransportResponse>((resolve, reject) => {
    const req = (options.url.protocol === 'https:' ? https.request : httpRequest)(options.url, {
      method: options.method,
      headers: options.headers,
      timeout: timeoutMs,
      ...(options.url.protocol === 'https:' && keepAliveHttpsAgent ? { agent: keepAliveHttpsAgent } : {}),
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) res.destroy(new Error('RESPONSE_TOO_LARGE'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const status = res.statusCode ?? 500;
        if (status >= 300 && status < 400) {
          reject(new Error('CHAT_REDIRECT_REFUSED'));
          return;
        }
        resolve({
          status,
          headers: {
            get: name => {
              const header = res.headers[name.toLowerCase()];
              return typeof header === 'string' ? header : null;
            },
          },
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('REQUEST_TIMEOUT')));
    req.on('error', reject);
    req.end(options.body);
  });
}

export function performChatHttpRequest(options: ChatHttpRequestOptions): Promise<ChatTransportResponse> {
  if (options.fetchImpl) return performWithNetFetch(options.fetchImpl, options);
  const useNetFetch = options.useNetFetch ?? shouldUseElectronNetFetch();
  if (useNetFetch) return performWithNetFetch((url, init) => net.fetch(url, init), options);
  return performWithNodeHttp(options);
}
