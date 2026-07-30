import { createHash } from 'node:crypto';

import { encodeThinkingBlock } from './translate-request.js';
import type { ToolCallMapping, ToolContext } from './types.js';

type JsonObject = Record<string, unknown>;

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number; reasoning_tokens?: number };
}

interface BlockState {
  kind: 'text' | 'tool_use' | 'thinking' | 'redacted_thinking';
  outputIndex: number;
  itemId: string;
  callId: string;
  wireName: string;
  text: string;
  args: string;
  signature: string;
  source: JsonObject;
  startInput: string;
  visibleSummary: boolean;
  done: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function deterministicId(prefix: string, responseId: string, index: number): string {
  const digest = createHash('sha256').update(`${responseId}\0${index}`).digest('hex').slice(0, 20);
  return `${prefix}_${digest}`;
}

function mapUsage(usage: Usage | undefined): JsonObject | undefined {
  if (!usage) return undefined;
  const fresh = number(usage.input_tokens);
  const read = number(usage.cache_read_input_tokens);
  const write = number(usage.cache_creation_input_tokens);
  const output = number(usage.output_tokens);
  const reasoning = number(usage.output_tokens_details?.thinking_tokens)
    || number(usage.output_tokens_details?.reasoning_tokens);
  return {
    input_tokens: fresh + read + write,
    output_tokens: output,
    total_tokens: fresh + read + write + output,
    input_tokens_details: { cached_tokens: read, cache_write_tokens: write },
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

function mappingFor(context: ToolContext, wireName: string): ToolCallMapping {
  return context.byWireName.get(wireName) ?? {
    wireName,
    name: wireName,
    kind: 'function',
  };
}

function customToolInputFromArguments(argumentsText: string): string {
  if (argumentsText.trim().length === 0) return '';
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (isObject(parsed) && typeof parsed.input === 'string') return parsed.input;
  } catch {
    // Anthropic-compatible providers may emit free-form arguments rather than JSON.
  }
  return argumentsText;
}

function toolSearchArgumentsFromText(argumentsText: string): JsonObject {
  if (argumentsText.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (isObject(parsed)) return parsed;
  } catch {
    // Preserve free-form search text from permissive Anthropic-compatible gateways.
  }
  return { query: argumentsText };
}

function sanitizeToolArguments(
  argumentsText: string,
  mapping: ToolCallMapping,
): string {
  const fallback = argumentsText.trim().length > 0 ? argumentsText : '{}';
  // Claude OAuth exposes its built-in Read tool on the reserved custom_Read wire
  // identity. User-defined tools may share the display name without this identity.
  if (mapping.kind !== 'function' || mapping.wireName !== 'custom_Read') return fallback;
  try {
    const parsed = JSON.parse(fallback) as unknown;
    if (!isObject(parsed)) return fallback;
    if (parsed.pages === '') delete parsed.pages;
    return JSON.stringify(parsed);
  } catch {
    return fallback;
  }
}

function outputCallItem(
  state: BlockState,
  context: ToolContext,
  status: 'in_progress' | 'completed' | 'incomplete',
): JsonObject {
  const mapping = mappingFor(context, state.wireName);
  if (mapping.kind === 'custom') {
    return {
      id: state.itemId,
      type: 'custom_tool_call',
      status,
      call_id: state.callId,
      name: mapping.name,
      input: customToolInputFromArguments(state.args),
      ...(mapping.namespace ? { namespace: mapping.namespace } : {}),
    };
  }
  if (mapping.kind === 'tool_search') {
    return {
      id: state.itemId,
      type: 'tool_search_call',
      status,
      call_id: state.callId,
      execution: 'client',
      arguments: toolSearchArgumentsFromText(state.args),
    };
  }
  return {
    id: state.itemId,
    type: 'function_call',
    status,
    call_id: state.callId,
    name: mapping.name,
    arguments: state.args,
    ...(mapping.namespace ? { namespace: mapping.namespace } : {}),
  };
}

function stopReasonToCompletion(reason: string | null): { status: string; incomplete?: string } {
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') {
    return { status: 'incomplete', incomplete: 'max_output_tokens' };
  }
  if (reason === 'refusal' || reason === 'content_filter') {
    return { status: 'incomplete', incomplete: 'content_filter' };
  }
  return { status: 'completed' };
}

export class AnthropicSseTranslator {
  private responseId = '';
  private model = '';
  private started = false;
  private terminal = false;
  private terminalMarker = false;
  private nextOutputIndex = 0;
  private stopReason: string | null = null;
  private usage: Usage | undefined;
  private readonly blocks = new Map<number, BlockState>();
  private readonly outputItems = new Map<number, JsonObject>();

  constructor(
    private readonly wireModel: string,
    private readonly toolContext: ToolContext,
  ) {
    this.model = wireModel;
  }

  push(raw: unknown): unknown[] {
    if (this.terminal || !isObject(raw)) return [];
    const type = text(raw.type);
    if (type === 'error') {
      return this.fail(this.errorMessage(raw));
    }
    if (type === 'message_start') return this.messageStart(raw);
    if (type === 'content_block_start') return this.blockStart(raw);
    if (type === 'content_block_delta') return this.blockDelta(raw);
    if (type === 'content_block_stop') return this.blockStop(raw);
    if (type === 'message_delta') return this.messageDelta(raw);
    if (type === 'message_stop') {
      this.terminalMarker = true;
      return this.complete();
    }
    return [];
  }

  pushJson(message: unknown): unknown[] {
    if (!isObject(message)) return this.fail('Anthropic returned an invalid JSON response');
    if (message.type === 'error' || message.error) return this.fail(this.errorMessage(message));
    const output: unknown[] = [];
    const start = { type: 'message_start', message: { ...message, content: [] } };
    output.push(...this.push(start));
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((block, index) => {
      if (!isObject(block)) return;
      // A JSON Messages response is converted into the same delta sequence as SSE.
      // Do not seed blockStart with text/thinking/signature, otherwise the synthetic
      // deltas below would be accumulated a second time.
      const startBlock = { ...block };
      delete startBlock.text;
      delete startBlock.thinking;
      delete startBlock.reasoning;
      delete startBlock.signature;
      output.push(...this.push({
        type: 'content_block_start',
        index,
        content_block: startBlock,
      }));
      if (block.type === 'text' && text(block.text)) {
        output.push(...this.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        }));
      } else if (
        (block.type === 'thinking' && text(block.thinking))
        || (block.type === 'reasoning' && text(block.reasoning))
      ) {
        output.push(...this.push({
          type: 'content_block_delta',
          index,
          delta: block.type === 'reasoning'
            ? { type: 'reasoning_delta', reasoning: block.reasoning }
            : { type: 'thinking_delta', thinking: block.thinking },
        }));
      }
      if (
        (block.type === 'thinking' || block.type === 'reasoning')
        && text(block.signature)
      ) {
        output.push(...this.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: block.signature },
        }));
      } else if (block.type === 'tool_use') {
        const input = typeof block.input === 'string'
          ? block.input
          : block.input === undefined
            ? ''
            : JSON.stringify(block.input);
        if (input) {
          output.push(...this.push({
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: input },
          }));
        }
      }
      output.push(...this.push({ type: 'content_block_stop', index }));
    });
    output.push(...this.push({
      type: 'message_delta',
      delta: { stop_reason: text(message.stop_reason) },
      usage: message.usage,
    }));
    output.push(...this.push({ type: 'message_stop' }));
    return output;
  }

  finish(): unknown[] {
    if (this.terminal) return [];
    if (this.stopReason || this.terminalMarker) return this.complete();
    return this.fail('upstream stream ended before message_stop (stream_truncated)');
  }

  fail(message: string): unknown[] {
    if (this.terminal) return [];
    const out: unknown[] = [];
    this.ensureStarted(out);
    out.push(...this.closeBlocks('incomplete'));
    this.terminal = true;
    out.push({
      type: 'response.failed',
      response: this.responseObject('failed', {
        error: { code: 'upstream_error', message },
      }),
    });
    return out;
  }

  private ensureStarted(out: unknown[]): void {
    if (this.started) return;
    this.started = true;
    if (!this.responseId) this.responseId = deterministicId('resp', this.wireModel, 0);
    const response = this.responseObject('in_progress');
    out.push({ type: 'response.created', response });
    out.push({ type: 'response.in_progress', response });
  }

  private messageStart(raw: JsonObject): unknown[] {
    const message = isObject(raw.message) ? raw.message : raw;
    const id = text(message.id);
    if (id) this.responseId = id.startsWith('resp_') ? id : `resp_${id}`;
    const model = text(message.model);
    if (model) this.model = model;
    if (isObject(message.usage)) this.usage = message.usage as Usage;
    const out: unknown[] = [];
    this.ensureStarted(out);
    return out;
  }

  private blockStart(raw: JsonObject): unknown[] {
    const index = number(raw.index);
    const block = isObject(raw.content_block) ? raw.content_block : {};
    const kind = text(block.type);
    const reasoning = kind === 'thinking' || kind === 'reasoning';
    const toolMapping = kind === 'tool_use'
      ? mappingFor(this.toolContext, text(block.name))
      : null;
    const outputIndex = this.nextOutputIndex++;
    const itemPrefix = toolMapping?.kind === 'tool_search'
      ? 'tsc'
      : toolMapping?.kind === 'custom'
        ? 'ctc'
        : kind === 'tool_use'
          ? 'fc'
          : reasoning || kind === 'redacted_thinking'
            ? 'rs'
            : 'msg';
    const source = kind === 'reasoning'
      ? {
          ...block,
          type: 'thinking',
          thinking: text(block.reasoning),
        }
      : { ...block };
    const itemId = deterministicId(itemPrefix, this.responseId || this.wireModel, outputIndex);
    const state: BlockState = {
      kind: kind === 'tool_use'
        ? 'tool_use'
        : reasoning
          ? 'thinking'
          : kind === 'redacted_thinking'
            ? 'redacted_thinking'
            : 'text',
      outputIndex,
      itemId,
      callId: text(block.id),
      wireName: text(block.name),
      text: text(block.text) || text(block.thinking) || text(block.reasoning),
      args: '',
      signature: text(block.signature),
      source,
      startInput: isObject(block.input) ? JSON.stringify(block.input) : '',
      visibleSummary: reasoning,
      done: false,
    };
    this.blocks.set(index, state);
    const out: unknown[] = [];
    this.ensureStarted(out);
    if (state.kind === 'text') {
      out.push({
        type: 'response.output_item.added',
        response_id: this.responseId,
        output_index: outputIndex,
        item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      });
      out.push({
        type: 'response.content_part.added',
        response_id: this.responseId,
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    } else if (state.kind === 'tool_use') {
      out.push({
        type: 'response.output_item.added',
        response_id: this.responseId,
        output_index: outputIndex,
        item: outputCallItem(state, this.toolContext, 'in_progress'),
      });
    } else {
      out.push({
        type: 'response.output_item.added',
        response_id: this.responseId,
        output_index: outputIndex,
        item: { id: itemId, type: 'reasoning', summary: [], status: 'in_progress' },
      });
      if (state.visibleSummary) {
        out.push({
          type: 'response.reasoning_summary_part.added',
          response_id: this.responseId,
          item_id: itemId,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        });
      }
    }
    return out;
  }

  private blockDelta(raw: JsonObject): unknown[] {
    const state = this.blocks.get(number(raw.index));
    if (!state) return [];
    const delta = isObject(raw.delta) ? raw.delta : {};
    const type = text(delta.type);
    if (type === 'text_delta') {
      const value = text(delta.text);
      state.text += value;
      return [{
        type: 'response.output_text.delta',
        response_id: this.responseId,
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: 0,
        delta: value,
      }];
    }
    if (type === 'thinking_delta' || type === 'reasoning_delta') {
      const value = type === 'reasoning_delta'
        ? text(delta.reasoning)
        : text(delta.thinking);
      state.text += value;
      state.source.thinking = state.text;
      return [{
        type: 'response.reasoning_summary_text.delta',
        response_id: this.responseId,
        item_id: state.itemId,
        output_index: state.outputIndex,
        summary_index: 0,
        delta: value,
      }];
    }
    if (type === 'signature_delta') {
      state.signature = text(delta.signature);
      state.source.signature = state.signature;
      return [];
    }
    if (type === 'input_json_delta') {
      const value = text(delta.partial_json);
      state.args += value;
      const mapping = mappingFor(this.toolContext, state.wireName);
      // Anthropic represents custom-tool free-form input as a compatibility JSON
      // object. Read also needs its arguments sanitized after the complete JSON has
      // arrived. Emitting either partial form would poison Codex before the done event.
      if (
        mapping.kind === 'custom'
        || mapping.kind === 'tool_search'
        || mapping.name === 'Read'
      ) return [];
      return [{
        type: 'response.function_call_arguments.delta',
        response_id: this.responseId,
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta: value,
      }];
    }
    return [];
  }

  private blockStop(raw: JsonObject, terminalStatus: 'completed' | 'incomplete' = 'completed'): unknown[] {
    const state = this.blocks.get(number(raw.index));
    if (!state || state.done) return [];
    state.done = true;
    if (state.kind === 'tool_use' && state.args.length === 0) state.args = state.startInput || '{}';
    const out: unknown[] = [];
    if (state.kind === 'text') {
      const content = [{ type: 'output_text', text: state.text, annotations: [] }];
      out.push({
        type: 'response.output_text.done',
        response_id: this.responseId,
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: 0,
        text: state.text,
      });
      out.push({
        type: 'response.content_part.done',
        response_id: this.responseId,
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: 0,
        part: content[0],
      });
      const item = {
        id: state.itemId,
        type: 'message',
        status: terminalStatus,
        role: 'assistant',
        content,
      };
      this.outputItems.set(state.outputIndex, item);
      out.push({ type: 'response.output_item.done', response_id: this.responseId, output_index: state.outputIndex, item });
    } else if (state.kind === 'tool_use') {
      const mapping = mappingFor(this.toolContext, state.wireName);
      state.args = sanitizeToolArguments(state.args, mapping);
      const item = outputCallItem(state, this.toolContext, terminalStatus);
      if (terminalStatus === 'completed' && mapping.kind !== 'tool_search') {
        out.push({
          type: mapping.kind === 'custom'
            ? 'response.custom_tool_call_input.done'
            : 'response.function_call_arguments.done',
          response_id: this.responseId,
          item_id: state.itemId,
          output_index: state.outputIndex,
          ...(mapping.kind === 'custom'
            ? { input: customToolInputFromArguments(state.args) }
            : { arguments: state.args }),
        });
      }
      this.outputItems.set(state.outputIndex, item);
      out.push({ type: 'response.output_item.done', response_id: this.responseId, output_index: state.outputIndex, item });
    } else {
      const source = {
        ...state.source,
        ...(state.kind === 'thinking' ? { thinking: state.text, signature: state.signature } : {}),
      };
      const encryptedContent = encodeThinkingBlock(source);
      const item = {
        id: state.itemId,
        type: 'reasoning',
        status: terminalStatus,
        summary: state.visibleSummary ? [{ type: 'summary_text', text: state.text }] : [],
        ...(encryptedContent ? { encrypted_content: encryptedContent } : {}),
      };
      if (state.visibleSummary) {
        out.push({
          type: 'response.reasoning_summary_text.done',
          response_id: this.responseId,
          item_id: state.itemId,
          output_index: state.outputIndex,
          summary_index: 0,
          text: state.text,
        });
        out.push({
          type: 'response.reasoning_summary_part.done',
          response_id: this.responseId,
          item_id: state.itemId,
          output_index: state.outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: state.text },
        });
      }
      this.outputItems.set(state.outputIndex, item);
      out.push({ type: 'response.output_item.done', response_id: this.responseId, output_index: state.outputIndex, item });
    }
    return out;
  }

  private messageDelta(raw: JsonObject): unknown[] {
    const delta = isObject(raw.delta) ? raw.delta : {};
    const reason = text(delta.stop_reason);
    if (reason) this.stopReason = reason;
    if (isObject(raw.usage)) this.usage = { ...(this.usage ?? {}), ...(raw.usage as Usage) };
    return [];
  }

  private closeBlocks(terminalStatus: 'completed' | 'incomplete' = 'completed'): unknown[] {
    const out: unknown[] = [];
    for (const [index, block] of this.blocks) {
      if (!block.done) out.push(...this.blockStop({ index }, terminalStatus));
    }
    return out;
  }

  private complete(): unknown[] {
    if (this.terminal) return [];
    const out = this.closeBlocks();
    this.terminal = true;
    const result = stopReasonToCompletion(this.stopReason);
    const extra = result.incomplete ? { incomplete_details: { reason: result.incomplete } } : {};
    out.push({
      type: result.status === 'completed' ? 'response.completed' : 'response.incomplete',
      response: this.responseObject(result.status, extra),
    });
    return out;
  }

  private responseObject(status: string, extra: JsonObject = {}): JsonObject {
    const output = [...this.outputItems.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, item]) => item);
    return {
      id: this.responseId || deterministicId('resp', this.wireModel, 0),
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: this.model || this.wireModel,
      output,
      ...(mapUsage(this.usage) ? { usage: mapUsage(this.usage) } : {}),
      ...extra,
    };
  }

  private errorMessage(raw: JsonObject): string {
    const error = isObject(raw.error) ? raw.error : raw;
    return text(error.message) || 'Anthropic upstream error';
  }
}
