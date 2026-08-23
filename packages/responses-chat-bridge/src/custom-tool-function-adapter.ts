import { Buffer } from 'node:buffer';
import { Transform, type TransformCallback } from 'node:stream';
import { TextDecoder } from 'node:util';

import { ChatBridgeToolContext, type ChatBridgeToolSpec } from './tool-context.js';
import type { ResponsesRequest } from './types.js';

const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 256;
const MAX_ACTIVE_RESPONSE_CALLS = 256;
const MAX_RESPONSE_ARGUMENT_BYTES = 16 * 1024 * 1024;
// The desktop proxy's upstream socket timeout is ten minutes. Keep mappings strictly longer so
// no request that can still be live is evicted, while failed/cancelled requests are eventually
// reclaimed instead of exhausting the bounded map for the rest of the process lifetime.
const PENDING_REQUEST_TTL_MS = 15 * 60 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function customToolName(tool: unknown): string | null {
  if (typeof tool === 'string') return tool;
  return isObject(tool) && tool.type === 'custom' && typeof tool.name === 'string'
    ? tool.name
    : null;
}

function stringifyInput(value: unknown): string {
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value ?? '');
  if (serialized === undefined) throw new Error('custom tool input is not JSON-serializable');
  return serialized;
}

function unwrapArguments(value: unknown): string {
  if (typeof value !== 'string') throw new Error('adapted custom tool call has no function arguments');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('adapted custom tool call arguments are not valid JSON');
  }
  if (!isObject(parsed) || typeof parsed.input !== 'string') {
    throw new Error('adapted custom tool call arguments have no string input');
  }
  return parsed.input;
}

interface AdaptedCall {
  spec: ChatBridgeToolSpec;
  arguments: string;
  input?: string;
}

/**
 * Restores one adapted upstream response to the Responses custom-tool dialect.
 *
 * SSE frames may split UTF-8, JSON, and parallel function arguments across chunks, so `pending`
 * holds incomplete framing while `calls` tracks each output index until its matching done event.
 * Non-streaming JSON is buffered until EOF. Invalid adapted arguments and oversized buffers fail
 * explicitly because passing a function call through would make Codex execute the wrong protocol.
 */
class CustomToolResponseTransform extends Transform {
  private readonly decoder = new TextDecoder();
  private readonly calls = new Map<number, AdaptedCall>();
  private pending = '';
  private responseArgumentBytes = 0;

  constructor(
    private readonly specs: ReadonlyMap<string, ChatBridgeToolSpec>,
    private readonly sse: boolean,
  ) {
    super();
  }

  private rewriteItem(item: unknown, call?: AdaptedCall): Record<string, unknown> | null {
    if (!isObject(item) || item.type !== 'function_call') return null;
    const spec = call?.spec ?? (typeof item.name === 'string' ? this.specs.get(item.name) : undefined);
    if (!spec) return null;
    const next: Record<string, unknown> = {
      ...item,
      type: 'custom_tool_call',
      name: spec.name,
      input: call?.input ?? unwrapArguments(call?.arguments ?? item.arguments),
    };
    delete next.arguments;
    return next;
  }
  private rewriteEvent(event: unknown): Record<string, unknown>[] | null {
    if (!isObject(event) || typeof event.type !== 'string') return null;
    const index = typeof event.output_index === 'number' ? event.output_index : -1;
    if (event.type === 'response.output_item.added' && isObject(event.item)) {
      const spec = event.item.type === 'function_call' && typeof event.item.name === 'string'
        ? this.specs.get(event.item.name)
        : undefined;
      if (!spec || index < 0) return null;
      const argumentsText = typeof event.item.arguments === 'string' ? event.item.arguments : '';
      const previous = this.calls.get(index);
      if (!previous && this.calls.size >= MAX_ACTIVE_RESPONSE_CALLS) {
        throw new Error('adapted custom tool response has too many active calls');
      }
      const nextArgumentBytes =
        this.responseArgumentBytes
        - (previous ? Buffer.byteLength(previous.arguments, 'utf8') : 0)
        + Buffer.byteLength(argumentsText, 'utf8');
      if (nextArgumentBytes > MAX_RESPONSE_ARGUMENT_BYTES) {
        throw new Error('adapted custom tool response arguments exceed the 16 MiB limit');
      }
      this.responseArgumentBytes = nextArgumentBytes;
      this.calls.set(index, {
        spec,
        arguments: argumentsText,
      });
      const item: Record<string, unknown> = {
        ...event.item, type: 'custom_tool_call', name: spec.name, input: '',
      };
      delete item.arguments;
      return [{ ...event, item }];
    }

    const call = this.calls.get(index);
    if (event.type === 'response.function_call_arguments.delta' && call) {
      if (typeof event.delta === 'string') {
        const deltaBytes = Buffer.byteLength(event.delta, 'utf8');
        if (this.responseArgumentBytes + deltaBytes > MAX_RESPONSE_ARGUMENT_BYTES) {
          throw new Error('adapted custom tool response arguments exceed the 16 MiB limit');
        }
        call.arguments += event.delta;
        this.responseArgumentBytes += deltaBytes;
      }
      return [];
    }
    if (event.type === 'response.function_call_arguments.done' && call) {
      call.input = unwrapArguments(typeof event.arguments === 'string' ? event.arguments : call.arguments);
      const delta: Record<string, unknown> = {
        ...event, type: 'response.custom_tool_call_input.delta', delta: call.input,
      };
      const done: Record<string, unknown> = {
        ...event, type: 'response.custom_tool_call_input.done', input: call.input,
      };
      delete delta.arguments;
      delete done.arguments;
      return [delta, done];
    }
    if (event.type === 'response.output_item.done') {
      const item = this.rewriteItem(event.item, call);
      if (!item) return null;
      this.calls.delete(index);
      this.responseArgumentBytes -= call ? Buffer.byteLength(call.arguments, 'utf8') : 0;
      return [{ ...event, item }];
    }
    if (isObject(event.response) && Array.isArray(event.response.output)) {
      let changed = false;
      const output = event.response.output.map((item) => {
        const next = this.rewriteItem(item);
        if (!next) return item;
        changed = true;
        return next;
      });
      if (changed) return [{ ...event, response: { ...event.response, output } }];
    }
    return null;
  }
  private rewriteFrame(frame: string, delimiter: string): string {
    const lines = frame.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return frame + delimiter;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return frame + delimiter;
    }
    const rewritten = this.rewriteEvent(event);
    if (rewritten === null) return frame + delimiter;
    const named = lines.some((line) => line.startsWith('event:'));
    return rewritten.map((next) => (
      `${named ? `event: ${String(next.type)}\n` : ''}data: ${JSON.stringify(next)}${delimiter}`
    )).join('');
  }
  private drainFrames(): void {
    // Keep the incomplete tail in `pending`; only complete SSE frames are safe to rewrite.
    for (;;) {
      const lf = this.pending.indexOf('\n\n');
      const crlf = this.pending.indexOf('\r\n\r\n');
      const index = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
      if (index < 0) return;
      const delimiter = index === crlf ? '\r\n\r\n' : '\n\n';
      this.push(this.rewriteFrame(this.pending.slice(0, index), delimiter));
      this.pending = this.pending.slice(index + delimiter.length);
    }
  }
  override _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    try {
      this.pending += this.decoder.decode(chunk, { stream: true });
      if (this.sse) this.drainFrames();
      if (Buffer.byteLength(this.pending, 'utf8') > MAX_PENDING_BYTES) {
        throw new Error('adapted custom tool response exceeds the 16 MiB buffer limit');
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
  override _flush(callback: TransformCallback): void {
    try {
      this.pending += this.decoder.decode();
      if (this.sse) {
        this.drainFrames();
        if (this.pending) this.push(this.rewriteFrame(this.pending, ''));
      } else {
        // A JSON response has no stable item boundary before EOF, so rewrite it as one document.
        const parsed = JSON.parse(this.pending) as unknown;
        const rewritten = this.rewriteEvent({ type: 'response.completed', response: parsed });
        this.push(JSON.stringify(rewritten?.[0]?.response ?? parsed));
      }
      this.pending = '';
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

export interface ResponsesCustomToolFunctionAdapter {
  adaptRequest(body: unknown, requestId: number): unknown | null;
  /** Idempotently release request-scoped response metadata after the request settles. */
  releaseResponse(requestId: number): void;
  createResponseTransform(requestId: number, response: {
    contentType: string; contentEncoding: string;
  }): Transform | null;
}

/** Symmetric adapter for Responses providers that only accept function tools. */
export function createResponsesCustomToolFunctionAdapter(
  customToolNames: readonly string[],
): ResponsesCustomToolFunctionAdapter {
  const selected = new Set(customToolNames);
  const responseSpecs = new Map<number, {
    specs: Map<string, ChatBridgeToolSpec>;
    createdAt: number;
  }>();

  const discardExpiredResponseSpecs = (now: number): void => {
    for (const [requestId, pending] of responseSpecs) {
      if (now - pending.createdAt >= PENDING_REQUEST_TTL_MS) responseSpecs.delete(requestId);
    }
  };

  return {
    adaptRequest(body, requestId) {
      if (!isObject(body) || !Array.isArray(body.tools)) return null;
      const context = ChatBridgeToolContext.fromRequest(body as unknown as ResponsesRequest);
      const specs = new Map<string, ChatBridgeToolSpec>();
      const functionNames = new Map<string, string>();
      const tools: unknown[] = [];
      for (const tool of body.tools) {
        const name = customToolName(tool);
        if (!name || !selected.has(name)) {
          tools.push(tool);
          continue;
        }
        if (functionNames.has(name)) continue;
        const functionName = context.chatNameForResponse(name, undefined, 'custom');
        const spec = context.lookupChatName(functionName);
        const chatTool = context.chatTools?.find((item) => item.function.name === functionName);
        if (!spec || !chatTool) throw new Error(`cannot adapt Responses custom tool '${name}'`);
        functionNames.set(name, functionName);
        specs.set(functionName, spec);
        tools.push({ type: 'function', ...chatTool.function });
      }
      if (specs.size === 0) return null;

      const calls = new Map<string, string>();
      if (Array.isArray(body.input)) {
        for (const item of body.input) {
          if (isObject(item) && item.type === 'custom_tool_call'
            && !Object.hasOwn(item, 'namespace')
            && typeof item.name === 'string' && typeof item.call_id === 'string') {
            const functionName = functionNames.get(item.name);
            if (functionName) calls.set(item.call_id, functionName);
          }
        }
      }
      const input = Array.isArray(body.input) ? body.input.map((item) => {
        if (!isObject(item) || typeof item.call_id !== 'string') return item;
        const functionName = calls.get(item.call_id);
        if (!functionName) return item;
        if (item.type === 'custom_tool_call') {
          const next: Record<string, unknown> = {
            ...item, type: 'function_call', name: functionName,
            arguments: JSON.stringify({ input: stringifyInput(item.input) }),
          };
          delete next.input;
          delete next.namespace;
          return next;
        }
        return item.type === 'custom_tool_call_output'
          ? { ...item, type: 'function_call_output' }
          : item;
      }) : body.input;
      let toolChoice = body.tool_choice;
      if (isObject(toolChoice) && toolChoice.type === 'custom' && typeof toolChoice.name === 'string') {
        const name = functionNames.get(toolChoice.name);
        if (name) toolChoice = { type: 'function', name };
      }
      const now = Date.now();
      discardExpiredResponseSpecs(now);
      if (!responseSpecs.has(requestId) && responseSpecs.size >= MAX_PENDING_REQUESTS) {
        throw new Error('too many in-flight custom tool requests to adapt safely');
      }
      responseSpecs.set(requestId, { specs, createdAt: now });
      const adapted: Record<string, unknown> = { ...body, tools, input };
      if (Object.hasOwn(body, 'tool_choice')) adapted.tool_choice = toolChoice;
      return adapted;
    },

    releaseResponse(requestId) {
      responseSpecs.delete(requestId);
    },

    createResponseTransform(requestId, response) {
      const pending = responseSpecs.get(requestId);
      responseSpecs.delete(requestId);
      const specs = pending?.specs;
      if (!specs?.size) return null;
      const encoding = response.contentEncoding.trim().toLowerCase();
      if (encoding && encoding !== 'identity') {
        throw new Error('compressed custom tool responses cannot be adapted safely');
      }
      const contentType = response.contentType.toLowerCase();
      const sse = contentType.startsWith('text/event-stream');
      if (!sse && !contentType.includes('application/json')) {
        throw new Error(`custom tool response has unsupported content type '${response.contentType}'`);
      }
      return new CustomToolResponseTransform(specs, sse);
    },
  };
}
