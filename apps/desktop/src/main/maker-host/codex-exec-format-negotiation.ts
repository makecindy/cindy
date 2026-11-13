import { createHmac, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createCodexResponsesCompatibilityAdapter } from '@cindy/model-compat';
import type { RequestTransformCtx, ResponseObserverCtx, RoutingDecision, RecoveryRule } from '@cindy/anthropic-compat-proxy';

type Mode = 'custom' | 'function';
type Entry = { mode?: Mode; at: number; generation: number };
type Attempt = { mode: Mode; generation: number; entry: Entry; key: string; failed: boolean; valid: () => boolean };
const TTL = 15 * 60_000;
const CAPACITY = 256;
const MAX_FRAME = 16 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Evidence of an accepted, restored Responses format, not proof that a tool ran. */
function validResponse(value: unknown): boolean {
  if (!object(value) || value.status !== 'completed' || typeof value.id !== 'string'
    || value.error || !Array.isArray(value.output) || !value.output.length) return false;
  return value.output.some(item => object(item) && item.type !== 'reasoning') && value.output.every(item => {
    if (!object(item)) return false;
    if (item.type === 'message') return Array.isArray(item.content) && item.content.some(part =>
      object(part) && ((part.type === 'output_text' && typeof part.text === 'string' && part.text.length > 0)
        || (part.type === 'refusal' && typeof part.refusal === 'string')));
    if (item.type === 'custom_tool_call') return typeof item.name === 'string' && typeof item.call_id === 'string' && typeof item.input === 'string';
    if (item.type === 'function_call') {
      if (typeof item.name !== 'string' || item.name === 'exec' || typeof item.arguments !== 'string' || typeof item.call_id !== 'string') return false;
      try { JSON.parse(item.arguments); return true; } catch { return false; }
    }
    return item.type === 'reasoning' && Array.isArray(item.summary);
  });
}

/** Never replay an HTTP 400 that actually contains usable Responses output. */
function rejectionWithoutOutput(text: string): boolean {
  const hasOutput = (value: unknown): boolean => object(value) && (
    (Array.isArray(value.output) && value.output.length > 0)
    || (object(value.response) && Array.isArray(value.response.output) && value.response.output.length > 0)
    || (typeof value.type === 'string' && /^response\.(?:output_|function_call_|custom_tool_call_)/.test(value.type))
  );
  try { if (hasOutput(JSON.parse(text))) return false; } catch { /* Error bodies need not be JSON. */ }
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try { if (hasOutput(JSON.parse(line.slice(5).trim()))) return false; } catch { /* Error text. */ }
  }
  return true;
}

/** A byte-preserving, bounded observer placed AFTER the reversible tool adapter. */
function acceptedResponse(contentType: string, accept: () => void): Transform | null {
  const sse = contentType.split(';', 1)[0].trim().toLowerCase() === 'text/event-stream';
  if (!sse && contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return null;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let invalid = false;
  let completed = false;
  const frame = (text: string): void => {
    const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    try {
      const event: unknown = JSON.parse(data);
      if (!object(event)) { invalid = true; return; }
      if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') invalid = true;
      if (event.type === 'response.completed') {
        completed = validResponse(event.response);
        if (!completed) invalid = true;
      }
    } catch { invalid = true; }
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!invalid) {
        pending += decoder.write(chunk);
        if (sse) {
          let delimiter: RegExpExecArray | null;
          while ((delimiter = /\r?\n\r?\n/.exec(pending))) {
            if (Buffer.byteLength(pending.slice(0, delimiter.index)) > MAX_FRAME) invalid = true;
            else frame(pending.slice(0, delimiter.index));
            pending = pending.slice(delimiter.index + delimiter[0].length);
          }
        }
        if (Buffer.byteLength(pending) > MAX_FRAME) { invalid = true; pending = ''; }
      }
      callback(null, chunk);
    },
    flush(callback) {
      pending += decoder.end();
      if (!invalid) {
        if (sse) { if (pending.trim()) invalid = true; }
        else { try { completed = validResponse(JSON.parse(pending)); } catch { invalid = true; } }
        if (completed && !invalid) accept();
      }
      callback();
    },
  });
}

/** Request-owned negotiation, sharing the proxy's existing single safe-retry budget.
 * Cache lifetime is this proxy only. Credentials never leave the HMAC computation.
 */
export function createCodexExecFormatNegotiation() {
  const adapter = createCodexResponsesCompatibilityAdapter();
  const secret = randomBytes(32);
  const entries = new Map<string, Entry>();
  const active = new Set<number>();
  const attempts = new WeakMap<Readonly<Record<string, string>>, Attempt>();
  return {
    releaseResponse(requestId: number): void {
      adapter.releaseResponse(requestId);
      active.delete(requestId);
    },
    dispose(): void {
      entries.clear();
      secret.fill(0);
      for (const requestId of active) adapter.releaseResponse(requestId);
      active.clear();
    },
    decorate(decision: RoutingDecision, ctx: RequestTransformCtx, identity: { providerId: string; revision: number; ownerScope: string; authStrategy: string }, valid: () => boolean): RoutingDecision {
      let attempt: Attempt | undefined;
      let original: Buffer | undefined;
      let switched = false;
      const originalTransform = decision.transformRequestBody;
      const convert = (mode: Mode): Buffer => {
        adapter.releaseResponse(ctx.reqId);
        active.delete(ctx.reqId);
        if (mode === 'custom') return original!;
        // Parse anew on EVERY attempt: alias/history state can never mutate the raw snapshot.
        const body: unknown = JSON.parse(original!.toString('utf8'));
        const adapted = adapter.adaptRequest(body, ctx.reqId);
        active.add(ctx.reqId);
        return Buffer.from(JSON.stringify(adapted ?? body));
      };
      const recovery: RecoveryRule = {
        id: 'codex_exec_format', statuses: [400], enabled: () => !!attempt,
        matches: rejectionWithoutOutput, applyOnUnmatchedRetry: false, allowExtraRules: false,
        strip: () => {
          if (!attempt || attempt.failed || switched || !valid()) return null;
          switched = true;
          attempt.entry.mode = undefined;
          attempt.generation = ++attempt.entry.generation;
          attempt.mode = attempt.mode === 'custom' ? 'function' : 'custom';
          try { return convert(attempt.mode); }
          catch {
            // An unrepresentable request is still the original rejected request;
            // never turn adapter failure into a third attempt or an async rejection.
            attempt.failed = true;
            adapter.releaseResponse(ctx.reqId);
            active.delete(ctx.reqId);
            return null;
          }
        },
      };
      return {
        ...decision,
        // The existing reversible adapters consume plaintext JSON/SSE. Negotiate
        // that representation before either format is sent, including raw first.
        headerOverride: { ...decision.headerOverride, 'accept-encoding': 'identity' },
        recoveryRules: [recovery],
        transformRequestBody: async (bytes, transformCtx) => {
          const rewritten = originalTransform ? await originalTransform(bytes, transformCtx) : { body: bytes };
          const body: unknown = JSON.parse(rewritten.body.toString('utf8'));
          if (!object(body) || !Array.isArray(body.tools) || !body.tools.some(tool => object(tool) && tool.type === 'custom' && tool.name === 'exec')) return rewritten;
          original = Buffer.from(rewritten.body);
          const base = new URL(transformCtx.upstreamBase!);
          const path = decision.pathOverride ?? ctx.url;
          const queryIndex = path.indexOf('?');
          const pathname = queryIndex < 0 ? path : path.slice(0, queryIndex);
          const query = queryIndex < 0 ? '' : path.slice(queryIndex + 1);
          const endpoint = `${base.origin}${base.pathname.replace(/\/+$/, '')}${pathname}?${[base.search.slice(1), query].filter(Boolean).join('&')}`;
          const headers = { ...ctx.headers, ...decision.headerOverride };
          for (const name of decision.headerDelete ?? []) delete headers[name.toLowerCase()];
          const auth = Object.entries(headers).filter(([name]) =>
            ['authorization', 'x-api-key', 'api-key', 'chatgpt-account-id'].includes(name.toLowerCase())
            || Object.keys(decision.headerOverride ?? {}).some(key => key.toLowerCase() === name.toLowerCase()))
            .map(([name, value]) => [name.toLowerCase(), value]).sort(([a], [b]) => a.localeCompare(b));
          const key = createHmac('sha256', secret).update(JSON.stringify([identity, endpoint, 'openai-responses', body.model, auth])).digest('hex');
          const now = Date.now();
          for (const [key, entry] of entries) if (now - entry.at >= TTL) entries.delete(key);
          let entry = entries.get(key);
          if (!entry) {
            if (entries.size >= CAPACITY) entries.delete(entries.keys().next().value!);
            entry = { at: now, generation: 0 }; entries.set(key, entry);
          }
          attempt = { key, entry, mode: entry.mode ?? 'custom', generation: entry.generation, failed: false, valid };
          attempts.set(ctx.headers, attempt);
          return { ...rewritten, body: convert(attempt.mode) };
        },
        forwardLifecycle: {
          onStart: () => decision.forwardLifecycle?.onStart?.(),
          onComplete: status => {
            adapter.releaseResponse(ctx.reqId);
            active.delete(ctx.reqId);
            decision.forwardLifecycle?.onComplete?.(status);
          },
          onFailure: (failure, status) => {
            if (attempt) attempt.failed = true;
            adapter.releaseResponse(ctx.reqId);
            active.delete(ctx.reqId);
            decision.forwardLifecycle?.onFailure?.(failure, status);
          },
        },
      };
    },
    restoreResponse(ctx: ResponseObserverCtx): Transform | null {
      active.delete(ctx.reqId);
      return adapter.createResponseTransform(ctx.reqId, {
        contentType: ctx.responseHeaders['content-type'] ?? '',
        contentEncoding: ctx.responseHeaders['content-encoding'] ?? '',
      });
    },
    responseTransform(ctx: ResponseObserverCtx): Transform | null {
      const attempt = attempts.get(ctx.requestHeaders);
      attempts.delete(ctx.requestHeaders);
      if (!attempt || ctx.status < 200 || ctx.status >= 300) return null;
      // The host has already put the adapter ahead of this observer. Compressed
      // bodies cannot prove successful restoration and must not seed the cache.
      if (ctx.responseHeaders['content-encoding'] && ctx.responseHeaders['content-encoding'] !== 'identity') return null;
      return acceptedResponse(ctx.responseHeaders['content-type'] ?? '', () => {
        if (attempt.failed || !attempt.valid() || entries.get(attempt.key) !== attempt.entry
          || attempt.entry.generation !== attempt.generation) return;
        attempt.entry.mode = attempt.mode;
        attempt.entry.at = Date.now();
      });
    },
  };
}
