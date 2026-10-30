import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createWebSocketMessageTransform, type ProxyOptions } from '@cindy/anthropic-compat-proxy';

const policies = new Map<string, () => boolean>();
export function registerCodexTextOnlyPolicy(threadId: string, disabled: () => boolean): () => void {
  policies.set(threadId, disabled);
  return () => {
    if (policies.get(threadId) !== disabled) return;
    // A native request may arrive after unsubscribe/close. Retain a small deny
    // tombstone until this thread is reopened or all proxy transports close.
    if (disabled()) policies.set(threadId, () => true);
    else policies.delete(threadId);
  };
}
export function clearCodexTextOnlyPolicies(): void { policies.clear(); }
export function isCodexTextOnly(threadId: string): boolean { return policies.get(threadId)?.() === true; }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function reject(reason = 'invalid payload', type?: unknown): never {
  // Diagnostics contain protocol identifiers only, never response text or tool arguments.
  const identifier = typeof type === 'string' && /^[a-zA-Z0-9_.-]{1,96}$/.test(type) ? type : 'unknown';
  throw new Error(`Codex text-only turn rejected ${reason} (type=${identifier})`);
}

/** Definitions are removed before any provider adapter or hosted tool can consume them. */
export function restrictCodexRequest(bytes: Buffer, options: { serial?: boolean; afterProvider?: boolean } = {}): Buffer {
  const body: unknown = JSON.parse(bytes.toString('utf8'));
  if (!object(body)) return reject();
  const next: Record<string, unknown> = { ...body, tools: [] };
  // Ingress disables tool selection before adapters inspect it. Non-Lite
  // egress has no tools, so remove controls that empty-tool providers reject,
  // including controls retained for hosted tools that we strip here.
  if (options.afterProvider && !options.serial) delete next.tool_choice;
  else next.tool_choice = 'none';
  delete next.parallel_tool_calls;
  // Responses-Lite requires an explicit serial flag, including on custom gateways.
  if (options.serial) next.parallel_tool_calls = false;
  return Buffer.from(JSON.stringify(next));
}

function validateItem(item: unknown): void {
  if (!object(item) || !['message', 'reasoning'].includes(String(item.type))) {
    reject('output item', object(item) ? item.type : undefined);
  }
}
/** A provider ignoring tool_choice must never deliver an executable item to the native runtime. */
export function validateCodexTextOnlyResponse(value: unknown): void {
  if (!object(value)) return reject();
  const validateOutput = (response: unknown) => {
    if (!object(response)) return reject();
    if (response.output !== undefined) {
      if (!Array.isArray(response.output)) return reject();
      response.output.forEach(validateItem);
    }
  };
  // Inspect output-bearing envelopes even on unfamiliar event types. Metadata
  // can evolve independently, but may not smuggle executable output through.
  if ('output' in value) validateOutput(value);
  if ('response' in value) validateOutput(value.response);
  if ('item' in value) validateItem(value.item);
  if (value.object === 'response' || Array.isArray(value.output)) { validateOutput(value); return; }
  const type = String(value.type ?? '');
  if (type === 'error' || (value.error && !type)) return;
  if (['response.created', 'response.in_progress', 'response.completed', 'response.done',
    'response.incomplete', 'response.failed', 'response.queued'].includes(type)) {
    validateOutput(value.response); return;
  }
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    validateItem(value.item); return;
  }
  if (type === 'response.content_part.added' || type === 'response.content_part.done') {
    if (!object(value.part) || !['output_text', 'text', 'refusal', 'reasoning_text', 'summary_text'].includes(String(value.part.type))) {
      reject('content part', object(value.part) ? value.part.type : undefined);
    }
    return;
  }
  // Match the whole call family, including _call_command and _call_code inputs.
  if (!type || /^response\.[^.]*_call(?:[._]|$)/.test(type)) {
    reject('tool event or missing event type', type);
  }
  // Rate limits, timing and other protocol metadata are not executable items.
  // Preserve them (and text deltas) instead of turning protocol additions into
  // a broken stream that makes the native runtime regenerate the greeting.
}

function parseResponse(bytes: string): unknown {
  try { return JSON.parse(bytes); }
  catch { return reject('invalid response JSON'); }
}

export function createCodexTextOnlyResponseGuard(contentType: string, encoding = ''): Transform {
  if (encoding && encoding !== 'identity') return reject();
  const sse = contentType.toLowerCase().includes('text/event-stream');
  if (!sse && !contentType.toLowerCase().includes('application/json')) return reject();
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const validateFrame = (frame: string) => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') validateCodexTextOnlyResponse(parseResponse(data));
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        pending += decoder.write(chunk);
        if (pending.length > 16 * 1024 * 1024) reject();
        if (sse) {
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(pending))) {
            const end = boundary.index + boundary[0].length;
            const frame = pending.slice(0, end);
            validateFrame(frame); this.push(frame); pending = pending.slice(end);
          }
        }
        callback();
      } catch (error) { callback(error as Error); }
    },
    flush(callback) {
      try {
        pending += decoder.end();
        if (pending.trim()) {
          if (sse) validateFrame(pending);
          else validateCodexTextOnlyResponse(parseResponse(pending));
          this.push(pending);
        }
        callback();
      } catch (error) { callback(error as Error); }
    },
  });
}

export function codexTextOnlyRequestGuard(
  disabled: boolean,
  ctx: { method: string; url: string; headers: Readonly<Record<string, string>> },
  requiresSerial: (upstreamBase: string | undefined) => boolean = () => false,
): ReturnType<NonNullable<ProxyOptions['requestGuard']>> {
  if (!disabled || ctx.method === 'GET' || ctx.method === 'HEAD') return null;
  if (!/\/responses\/?(?:\?.*)?$/.test(ctx.url)
    || (ctx.headers['content-encoding'] && ctx.headers['content-encoding'] !== 'identity')) return reject();
  return {
    transformBody: (body, route) => restrictCodexRequest(body, {
      afterProvider: Boolean(route),
      // Local protocol bridges consume ingress before this final outbound pass.
      // Keep their empty-tool compatibility; forwarded Lite requests need false.
      serial: Boolean(route) && (requiresSerial(route?.upstreamBase)
        || ctx.headers['x-openai-internal-codex-responses-lite'] === 'true'),
    }),
    response: headers => createCodexTextOnlyResponseGuard(String(headers['content-type'] ?? ''), String(headers['content-encoding'] ?? '')),
  };
}

export function codexTextOnlyWebSocketTransforms(
  disabled: () => boolean,
  requiresSerial = false,
  transformRequest: (message: Buffer, signal: AbortSignal) => Buffer | Promise<Buffer> = message => message,
) {
  // Frozen at each request, never relaxed by a subsequent UI send or teardown.
  let restricted = false;
  let completed = true;
  return {
    outbound: createWebSocketMessageTransform(true, (message, signal) => {
      const next = disabled();
      if (restricted && !completed) reject();
      restricted = next;
      completed = false;
      return transformRequest(restricted ? restrictCodexRequest(message, { serial: requiresSerial }) : message, signal);
    }),
    inbound: createWebSocketMessageTransform(false, message => {
      if (restricted) {
        const event = parseResponse(message.toString('utf8'));
        validateCodexTextOnlyResponse(event);
        if (object(event) && ['response.completed', 'response.done', 'response.failed', 'response.incomplete', 'error'].includes(String(event.type))) completed = true;
      }
      return message;
    }),
  };
}
