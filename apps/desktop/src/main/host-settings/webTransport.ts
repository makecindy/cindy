import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { retryAfterDelayMs } from './retryAfter.js';
import { HOST_SETTINGS_DOMAINS } from '../../shared/hostSettings.js';
import { settingsWebCommandSchema, settingsWebResultSchema, SETTINGS_WEB_MAX_BYTES, type SettingsWebEnvelope, type SettingsWebResult } from '../../shared/settingsWeb.js';

export interface SettingsWebContext { scopeKey: string; baseUrl: string; accessToken: string }
export interface SettingsWebTransportOptions {
  getContext(): SettingsWebContext | null;
  fetch: typeof globalThis.fetch;
  execute(request: SettingsWebEnvelope, assertCurrent: () => void): Promise<SettingsWebResult>;
  now?: () => number;
  managementV1?: boolean;
  /** Owner-only calls from the cloud instance service's browser pages. */
  hostCalls?: { channels: string[]; desktopV1: true };
}
const envelope = z.strictObject({ requestId: z.string().uuid(), runtimeId: z.string().uuid(), sessionKey: z.string().regex(/^[a-f0-9]{64}$/u), expiresAtMs: z.number().safe().int(), command: settingsWebCommandSchema });
class TransportError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null = null) { super('SETTINGS_WEB_TRANSPORT_UNAVAILABLE'); }
}
/** How long the service asked to wait, from a throttled or unavailable response's Retry-After. */
function serverRetryDelay(response: Response): number | null {
  return response.status === 429 || response.status === 503 ? retryAfterDelayMs(response) : null;
}

/** One request at a time. A delivery failure retries only the result, never the write. */
export function createSettingsWebTransport(options: SettingsWebTransportOptions) {
  const now = options.now ?? Date.now;
  let stopped = false;
  let scope = '';
  let runtimeId = '';
  let connected = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let abort: AbortController | null = null;
  const current = (context: SettingsWebContext) => {
    const fresh = options.getContext();
    return !stopped && fresh?.scopeKey === context.scopeKey && fresh.baseUrl === context.baseUrl;
  };
  const post = async (context: SettingsWebContext, path: string, body: unknown): Promise<unknown> => {
    if (!current(context)) throw new Error('OWNER_CHANGED');
    const base = new URL(context.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('SETTINGS_WEB_ENDPOINT_INVALID');
    const url = new URL(`${base.pathname.replace(/\/$/u, '')}/instances/self/settings/${path}`, base.origin);
    abort = new AbortController();
    const timeout = setTimeout(() => abort?.abort(), 8_000);
    try {
      const response = await options.fetch(url.href, { method: 'POST', headers: { Authorization: `Bearer ${options.getContext()!.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: abort.signal });
      if (!response.ok) { const retryAfterMs = serverRetryDelay(response); await response.body?.cancel(); throw new TransportError(response.status, retryAfterMs); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('SETTINGS_WEB_RESPONSE_INVALID');
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > SETTINGS_WEB_MAX_BYTES) { await reader.cancel(); throw new Error('SETTINGS_WEB_RESPONSE_TOO_LARGE'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      if (!current(context)) throw new Error('OWNER_CHANGED');
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { clearTimeout(timeout); abort = null; }
  };
  const runOnce = async (): Promise<number> => {
    if (stopped || inFlight) return 2_000;
    const context = options.getContext();
    if (!context) return 5_000;
    inFlight = true;
    try {
      const nextScope = JSON.stringify([context.scopeKey, context.baseUrl]);
      if (scope !== nextScope) { scope = nextScope; runtimeId = randomUUID(); connected = false; }
      if (!connected) {
        // Old CIS uses a strict connect schema. Drop optional features, newest first, only
        // on schema rejection; auth/network failures never downgrade.
        const base = { runtimeId, domains: HOST_SETTINGS_DOMAINS };
        const bodies = [
          ...(options.hostCalls ? [{ ...base, readBatch: true, ...(options.managementV1 ? { managementV1: true } : {}), ...options.hostCalls }] : []),
          ...(options.managementV1 ? [{ ...base, readBatch: true, managementV1: true }] : []),
          { ...base, readBatch: true },
          base,
        ];
        for (const [index, body] of bodies.entries()) {
          try { await post(context, 'connect', body); break; }
          catch (error) { if (index === bodies.length - 1 || !(error instanceof TransportError) || error.status !== 400) throw error; }
        }
        connected = true;
      }
      const polledAt = now();
      const response = z.strictObject({ request: envelope.nullable() }).parse(await post(context, 'poll', { runtimeId }));
      // After a held (long) poll, ask again at once so a browser's next call is not delayed.
      if (!response.request) return now() - polledAt >= 4_000 ? 50 : 2_000;
      const request = response.request;
      const assertCurrent = () => {
        if (!current(context) || request.runtimeId !== runtimeId || request.expiresAtMs <= now() || request.expiresAtMs > now() + 35_000) throw new Error('SETTINGS_WEB_REQUEST_EXPIRED');
      };
      let result: SettingsWebResult;
      try { assertCurrent(); result = settingsWebResultSchema.parse(await options.execute(request, assertCurrent)); }
      catch { result = { ok: false, code: 'SETTINGS_REQUEST_FAILED' }; }
      // A failed acknowledgement must not re-enter execute. The same immutable receipt
      // can be delivered again, including after the execution deadline.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { await post(context, `requests/${request.requestId}/result`, { runtimeId, result }); break; }
        catch (error) { if (attempt === 2 || !current(context) || error instanceof TransportError && error.status < 500) throw error; }
      }
      return 50;
    } catch (error) {
      if (error instanceof TransportError && error.status === 404) { connected = false; return 60_000; }
      if (error instanceof TransportError && error.status === 409) { connected = false; return 20_000; }
      // The service's Retry-After is the earliest next request; the local backoff applies without one.
      if (error instanceof TransportError && error.retryAfterMs !== null) return Math.max(5_000, error.retryAfterMs);
      return 5_000;
    } finally { inFlight = false; }
  };
  const tick = async () => { const delay = await runOnce(); if (!stopped) timer = setTimeout(() => { void tick(); }, delay); };
  return { runOnce, start() { if (!timer && !stopped && !inFlight) void tick(); }, stop() { stopped = true; if (timer) clearTimeout(timer); abort?.abort(); } };
}
