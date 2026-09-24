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
function reject(): never { throw new Error('Codex text-only turn rejected a tool-capable payload'); }

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
  // Only the resolved ChatGPT Responses route needs the Lite serial flag.
  if (options.serial) next.parallel_tool_calls = false;
  return Buffer.from(JSON.stringify(next));
}

function validateItem(item: unknown): void {
  if (!object(item) || !['message', 'reasoning'].includes(String(item.type))) reject();
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
    if (!object(value.part) || !['output_text', 'text', 'refusal', 'reasoning_text', 'summary_text'].includes(String(value.part.type))) reject();
    return;
  }
  if (/^response\.(output_text|refusal|reasoning_text|reasoning_summary_text|reasoning_summary_part)\.(delta|done|added)$/.test(type)
    || type === 'response.output_text.annotation.added') return;
  reject();
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
    if (data && data !== '[DONE]') validateCodexTextOnlyResponse(JSON.parse(data));
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
          else validateCodexTextOnlyResponse(JSON.parse(pending));
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
      serial: Boolean(route) && requiresSerial(route?.upstreamBase),
    }),
    response: headers => createCodexTextOnlyResponseGuard(String(headers['content-type'] ?? ''), String(headers['content-encoding'] ?? '')),
  };
}

export function codexTextOnlyWebSocketTransforms(disabled: () => boolean, requiresSerial = false) {
  // Frozen at each request, never relaxed by a subsequent UI send or teardown.
  let restricted = false;
  let completed = true;
  return {
    outbound: createWebSocketMessageTransform(true, message => {
      const next = disabled();
      if (restricted && !completed) reject();
      restricted = next;
      completed = false;
      return restricted ? restrictCodexRequest(message, { serial: requiresSerial }) : message;
    }),
    inbound: createWebSocketMessageTransform(false, message => {
      if (restricted) {
        const event: unknown = JSON.parse(message.toString('utf8'));
        validateCodexTextOnlyResponse(event);
        if (object(event) && ['response.completed', 'response.done', 'response.failed', 'response.incomplete', 'error'].includes(String(event.type))) completed = true;
      }
      return message;
    }),
  };
}
