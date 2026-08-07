import { createHash } from 'node:crypto';

import type { ChatBridgeToolContext } from './tool-context.js';

interface ToolState {
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  emittedArgumentsLength: number;
  added: boolean;
  done: boolean;
}

interface ReasoningState {
  outputIndex: number;
  itemId: string;
  text: string;
  added: boolean;
  done: boolean;
}

interface UsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  /** DeepSeek-compatible cache counters exposed alongside prompt_tokens. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface ResponseAnnotation {
  type: 'url_citation';
  url: string;
  title?: string;
  start_index: number;
  end_index: number;
}

export interface ChatSseTranslatorOptions {
  toolContext?: ChatBridgeToolContext;
  zeroUsageOnMissing?: boolean;
  inlineReasoning?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function deterministicId(prefix: string, responseId: string, index: number): string {
  const digest = createHash('sha256').update(`${responseId}\0${index}`).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function reasoningText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(reasoningText).filter(Boolean).join('');
  if (!isPlainObject(value)) return '';
  for (const key of ['reasoning_content', 'content', 'text', 'summary']) {
    const text = reasoningText(value[key]);
    if (text) return text;
  }
  return '';
}

function extractReasoning(delta: Record<string, unknown>): string {
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_details']) {
    const text = reasoningText(delta[key]);
    if (text) return text;
  }
  return '';
}

function annotationsFrom(value: unknown): ResponseAnnotation[] {
  if (!Array.isArray(value)) return [];
  const result: ResponseAnnotation[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const source = isPlainObject(entry.url_citation) ? entry.url_citation : entry;
    if (typeof source.url !== 'string' || !source.url) continue;
    result.push({
      type: 'url_citation',
      url: source.url,
      ...(typeof source.title === 'string' ? { title: source.title } : {}),
      start_index: typeof source.start_index === 'number' ? source.start_index : 0,
      end_index: typeof source.end_index === 'number' ? source.end_index : 0,
    });
  }
  return result;
}

function inlineCitationAnnotations(value: unknown): ResponseAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string' && /^https?:\/\//.test(entry)) {
      return [{ type: 'url_citation' as const, url: entry, start_index: 0, end_index: 0 }];
    }
    return annotationsFrom([entry]);
  });
}

function customInput(argumentsText: string): string {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (isPlainObject(parsed) && typeof parsed.input === 'string') return parsed.input;
  } catch {
    // A provider may return a raw freeform argument buffer.
  }
  return argumentsText;
}

function toolSearchArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Chat Completions SSE → OpenAI Responses SSE state machine. The state is deliberately
 * request-scoped so flattened namespace/custom/tool-search names can be restored exactly.
 */
export class ChatSseTranslator {
  private responseId = '';
  private model: string;
  private created = 0;
  private started = false;
  private terminal = false;
  private nextOutputIndex = 0;
  private messageOutputIndex: number | null = null;
  private messageItemId = '';
  private messageStarted = false;
  private messageDone = false;
  private textStarted = false;
  private textContentIndex: number | null = null;
  private text = '';
  private refusalStarted = false;
  private refusalContentIndex: number | null = null;
  private refusal = '';
  private nextMessageContentIndex = 0;
  private pendingFinishReason: string | null = null;
  private sawTerminalMarker = false;
  private readonly reasoningItems: ReasoningState[] = [];
  private readonly tools = new Map<number, ToolState>();
  private readonly annotations: ResponseAnnotation[] = [];
  private usage: UsageShape | undefined;
  private serviceTier = '';
  private inlineThinkMode: 'undecided' | 'reasoning' | 'text' = 'undecided';
  private inlineThinkBuffer = '';
  private readonly toolContext?: ChatBridgeToolContext;
  private readonly zeroUsageOnMissing: boolean;
  private readonly inlineReasoning: boolean;

  constructor(model: string, options: ChatSseTranslatorOptions = {}) {
    this.model = model;
    this.toolContext = options.toolContext;
    this.zeroUsageOnMissing = options.zeroUsageOnMissing !== false;
    this.inlineReasoning = options.inlineReasoning === true;
  }

  push(raw: unknown): unknown[] {
    if (this.terminal || !isPlainObject(raw)) return [];
    const out: unknown[] = [];
    const rawId = stringField(raw.id);
    if (rawId && !this.started) this.responseId = rawId;
    const rawModel = stringField(raw.model);
    if (rawModel) this.model = rawModel;
    const rawCreated = numberField(raw.created);
    if (rawCreated) this.created = rawCreated;
    const rawServiceTier = stringField(raw.service_tier);
    if (rawServiceTier) this.serviceTier = rawServiceTier;
    this.ensureStarted(out);

    if (isPlainObject(raw.error)) {
      const message = stringField(raw.error.message) || 'provider returned an error event';
      for (const event of this.fail(message)) out.push(event);
      return out;
    }
    if (isPlainObject(raw.usage)) this.usage = raw.usage as UsageShape;
    const choices = Array.isArray(raw.choices) ? raw.choices : [];
    for (const choiceValue of choices) {
      if (!isPlainObject(choiceValue)) continue;
      const delta = isPlainObject(choiceValue.delta)
        ? choiceValue.delta
        : isPlainObject(choiceValue.message)
          ? choiceValue.message
          : {};
      const reasoning = extractReasoning(delta);
      if (reasoning) {
        this.flushInlineThinkAtBoundary(out);
        this.ensureReasoning(out);
        this.appendReasoning(reasoning, out);
      }
      const content = typeof delta.content === 'string'
        ? delta.content
        : Array.isArray(delta.content)
          ? delta.content.map((part) => isPlainObject(part) ? stringField(part.text) : '').join('')
          : '';
      if (content) this.consumeContent(content, out);
      const refusal = stringField(delta.refusal);
      if (refusal) this.pushRefusal(refusal, out);
      this.annotations.push(
        ...annotationsFrom(delta.annotations),
        ...inlineCitationAnnotations(delta.citations),
        ...annotationsFrom(choiceValue.annotations),
      );
      if (Array.isArray(delta.tool_calls)) {
        this.flushInlineThinkAtBoundary(out);
        for (const [toolIndex, toolCall] of delta.tool_calls.entries()) {
          const normalizedToolCall = isPlainObject(toolCall) && typeof toolCall.index !== 'number'
            ? { ...toolCall, index: toolIndex }
            : toolCall;
          this.consumeToolDelta(normalizedToolCall, out);
        }
      }
      const finishReason = typeof choiceValue.finish_reason === 'string' ? choiceValue.finish_reason : null;
      if (finishReason) {
        this.pendingFinishReason = finishReason;
        this.sawTerminalMarker = true;
      }
    }
    return out;
  }

  markTerminal(): void {
    this.sawTerminalMarker = true;
  }

  finish(requireTerminalMarker = false): unknown[] {
    if (this.terminal) return [];
    if (requireTerminalMarker && !this.sawTerminalMarker) {
      return this.fail('upstream SSE stream ended before a terminal marker');
    }
    const out: unknown[] = [];
    this.ensureStarted(out);
    this.flushInlineThinkAtBoundary(out);
    this.complete(this.pendingFinishReason ?? 'stop', out);
    return out;
  }

  fail(message: string): unknown[] {
    if (this.terminal) return [];
    const out: unknown[] = [];
    this.ensureStarted(out);
    this.flushInlineThinkAtBoundary(out);
    this.closeOpenItems(out);
    this.terminal = true;
    out.push({
      type: 'response.failed',
      response: this.responseObject('failed', { error: { code: 'upstream_stream_error', message } }),
    });
    return out;
  }

  private ensureStarted(out: unknown[]): void {
    if (this.started) return;
    this.started = true;
    if (!this.responseId) this.responseId = deterministicId('resp', this.model, 0);
    out.push({ type: 'response.created', response: this.responseObject('in_progress') });
    out.push({ type: 'response.in_progress', response: this.responseObject('in_progress') });
  }

  private ensureReasoning(out: unknown[]): ReasoningState {
    const current = this.reasoningItems.find((item) => !item.done);
    if (current) return current;
    const outputIndex = this.nextOutputIndex++;
    const state: ReasoningState = {
      outputIndex,
      itemId: deterministicId('rs', this.responseId, outputIndex),
      text: '',
      added: true,
      done: false,
    };
    this.reasoningItems.push(state);
    out.push({
      type: 'response.output_item.added',
      response_id: this.responseId,
      output_index: outputIndex,
      item: { id: state.itemId, type: 'reasoning', status: 'in_progress', summary: [] },
    });
    out.push({
      type: 'response.reasoning_summary_part.added',
      item_id: state.itemId,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
    return state;
  }

  private appendReasoning(reasoning: string, out: unknown[]): void {
    const state = this.ensureReasoning(out);
    state.text += reasoning;
    out.push({
      type: 'response.reasoning_summary_text.delta',
      item_id: state.itemId,
      output_index: state.outputIndex,
      summary_index: 0,
      delta: reasoning,
    });
  }

  private closeReasoning(state: ReasoningState, out: unknown[]): void {
    if (state.done) return;
    state.done = true;
    out.push({
      type: 'response.reasoning_summary_text.done',
      item_id: state.itemId,
      output_index: state.outputIndex,
      summary_index: 0,
      text: state.text,
    });
    out.push({
      type: 'response.reasoning_summary_part.done',
      item_id: state.itemId,
      output_index: state.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: state.text },
    });
    out.push({
      type: 'response.output_item.done',
      response_id: this.responseId,
      output_index: state.outputIndex,
      item: { id: state.itemId, type: 'reasoning', summary: [{ type: 'summary_text', text: state.text }] },
    });
  }

  private closeActiveReasoning(out: unknown[]): void {
    const current = this.reasoningItems.find((item) => !item.done);
    if (current) this.closeReasoning(current, out);
  }

  private consumeContent(content: string, out: unknown[]): void {
    if (!this.inlineReasoning) {
      this.pushText(content, out);
      return;
    }
    if (this.inlineThinkMode === 'text') {
      this.pushText(content, out);
      return;
    }
    this.inlineThinkBuffer += content;
    const trimmed = this.inlineThinkBuffer.trimStart();
    if (this.inlineThinkMode === 'undecided') {
      if ('<think>'.startsWith(trimmed.toLowerCase())) return;
      if (trimmed.toLowerCase().startsWith('<think>')) {
        this.inlineThinkMode = 'reasoning';
        this.inlineThinkBuffer = trimmed.slice('<think>'.length);
      } else {
        this.inlineThinkMode = 'text';
        const text = this.inlineThinkBuffer;
        this.inlineThinkBuffer = '';
        this.pushText(text, out);
        return;
      }
    }
    const closeTag = '</think>';
    const lower = this.inlineThinkBuffer.toLowerCase();
    const closeIndex = lower.indexOf(closeTag);
    if (closeIndex >= 0) {
      const thinking = this.inlineThinkBuffer.slice(0, closeIndex);
      if (thinking) this.appendReasoning(thinking, out);
      this.closeActiveReasoning(out);
      this.inlineThinkMode = 'text';
      const answer = this.inlineThinkBuffer.slice(closeIndex + closeTag.length);
      this.inlineThinkBuffer = '';
      if (answer) this.pushText(answer, out);
      return;
    }
    const keep = closeTag.length - 1;
    const emitLength = Math.max(0, this.inlineThinkBuffer.length - keep);
    if (emitLength > 0) {
      this.appendReasoning(this.inlineThinkBuffer.slice(0, emitLength), out);
      this.inlineThinkBuffer = this.inlineThinkBuffer.slice(emitLength);
    }
  }

  private flushInlineThinkAtBoundary(out: unknown[]): void {
    if (!this.inlineReasoning) return;
    if (this.inlineThinkMode === 'undecided') {
      if (this.inlineThinkBuffer) this.pushText(this.inlineThinkBuffer, out);
    } else if (this.inlineThinkMode === 'reasoning') {
      if (this.inlineThinkBuffer) this.appendReasoning(this.inlineThinkBuffer, out);
    }
    this.inlineThinkMode = this.inlineThinkMode === 'reasoning' ? 'text' : this.inlineThinkMode;
    this.inlineThinkBuffer = '';
  }

  private pushText(content: string, out: unknown[]): void {
    this.closeActiveReasoning(out);
    this.ensureText(out);
    this.text += content;
    out.push({
      type: 'response.output_text.delta',
      item_id: this.messageItemId,
      response_id: this.responseId,
      output_index: this.messageOutputIndex,
      content_index: this.textContentIndex,
      delta: content,
    });
  }

  private ensureMessage(out: unknown[]): void {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.messageOutputIndex = this.nextOutputIndex++;
    this.messageItemId = deterministicId('msg', this.responseId, this.messageOutputIndex);
    out.push({
      type: 'response.output_item.added',
      response_id: this.responseId,
      output_index: this.messageOutputIndex,
      item: { id: this.messageItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
  }

  private ensureText(out: unknown[]): void {
    this.ensureMessage(out);
    if (this.textStarted) return;
    this.textStarted = true;
    this.textContentIndex = this.nextMessageContentIndex++;
    out.push({
      type: 'response.content_part.added',
      response_id: this.responseId,
      item_id: this.messageItemId,
      output_index: this.messageOutputIndex,
      content_index: this.textContentIndex,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  private pushRefusal(refusal: string, out: unknown[]): void {
    this.closeActiveReasoning(out);
    this.ensureMessage(out);
    if (!this.refusalStarted) {
      this.refusalStarted = true;
      this.refusalContentIndex = this.nextMessageContentIndex++;
      out.push({
        type: 'response.content_part.added',
        response_id: this.responseId,
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: this.refusalContentIndex,
        part: { type: 'refusal', refusal: '' },
      });
    }
    this.refusal += refusal;
    out.push({
      type: 'response.refusal.delta',
      response_id: this.responseId,
      item_id: this.messageItemId,
      output_index: this.messageOutputIndex,
      content_index: this.refusalContentIndex,
      delta: refusal,
    });
  }

  private consumeToolDelta(raw: unknown, out: unknown[]): void {
    if (!isPlainObject(raw) || typeof raw.index !== 'number') return;
    const index = raw.index;
    let state = this.tools.get(index);
    if (!state) {
      const outputIndex = this.nextOutputIndex++;
      state = {
        outputIndex,
        itemId: deterministicId('fc', this.responseId, index),
        callId: stringField(raw.id) || deterministicId('call', this.responseId, index),
        name: '',
        arguments: '',
        emittedArgumentsLength: 0,
        added: false,
        done: false,
      };
      this.tools.set(index, state);
    }
    const callId = stringField(raw.id);
    if (callId && !state.added) state.callId = callId;
    const functionPart = isPlainObject(raw.function) ? raw.function : {};
    const name = stringField(functionPart.name);
    if (name) state.name += name;
    const args = stringField(functionPart.arguments);
    if (args) state.arguments += args;
    this.addToolWhenReady(state, out);
    if (state.added) {
      const delta = state.arguments.slice(state.emittedArgumentsLength);
      state.emittedArgumentsLength = state.arguments.length;
      if (delta && !this.isCustomOrToolSearch(state.name)) {
        out.push({
          type: 'response.function_call_arguments.delta',
          response_id: this.responseId,
          item_id: state.itemId,
          output_index: state.outputIndex,
          delta,
        });
      }
    }
  }

  private isCustomOrToolSearch(name: string): boolean {
    const kind = this.toolContext?.lookupChatName(name)?.kind;
    return kind === 'custom' || kind === 'tool_search';
  }

  private toolItem(state: ToolState, status: 'in_progress' | 'completed'): Record<string, unknown> {
    const spec = this.toolContext?.lookupChatName(state.name);
    if (spec?.kind === 'custom') {
      return {
        id: state.itemId,
        type: 'custom_tool_call',
        status,
        call_id: state.callId,
        name: spec.name,
        ...(spec.namespace ? { namespace: spec.namespace } : {}),
        input: status === 'in_progress' ? '' : customInput(state.arguments),
      };
    }
    if (spec?.kind === 'tool_search') {
      return {
        id: state.itemId,
        type: 'tool_search_call',
        status,
        call_id: state.callId,
        execution: 'client',
        arguments: status === 'in_progress' ? {} : toolSearchArguments(state.arguments),
      };
    }
    return {
      id: state.itemId,
      type: 'function_call',
      status,
      call_id: state.callId,
      name: spec?.name ?? state.name,
      ...(spec?.namespace ? { namespace: spec.namespace } : {}),
      arguments: status === 'in_progress' ? '' : state.arguments,
    };
  }

  private addToolWhenReady(state: ToolState, out: unknown[], force = false): void {
    if (
      state.added
      || !state.name
      || (!force && !state.arguments && !this.pendingFinishReason)
    ) return;
    const spec = this.toolContext?.lookupChatName(state.name);
    if (!force && this.toolContext?.hasChatNamePrefix(state.name)) return;
    const kind = spec?.kind;
    state.itemId = deterministicId(
      kind === 'custom' ? 'ctc' : kind === 'tool_search' ? 'tsc' : 'fc',
      this.responseId,
      state.outputIndex,
    );
    state.added = true;
    out.push({
      type: 'response.output_item.added',
      response_id: this.responseId,
      output_index: state.outputIndex,
      item: this.toolItem(state, 'in_progress'),
    });
  }

  private closeMessage(out: unknown[]): void {
    if (!this.messageStarted || this.messageDone || this.messageOutputIndex === null) return;
    this.messageDone = true;
    const content = this.messageContent();
    if (this.textStarted && this.textContentIndex !== null) {
      const part = content[this.textContentIndex];
      out.push({
        type: 'response.output_text.done',
        response_id: this.responseId,
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: this.textContentIndex,
        text: this.text,
      });
      out.push({
        type: 'response.content_part.done',
        response_id: this.responseId,
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: this.textContentIndex,
        part,
      });
    }
    if (this.refusalStarted && this.refusalContentIndex !== null) {
      const part = content[this.refusalContentIndex];
      out.push({
        type: 'response.refusal.done',
        response_id: this.responseId,
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: this.refusalContentIndex,
        refusal: this.refusal,
      });
      out.push({
        type: 'response.content_part.done',
        response_id: this.responseId,
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: this.refusalContentIndex,
        part,
      });
    }
    out.push({
      type: 'response.output_item.done',
      response_id: this.responseId,
      output_index: this.messageOutputIndex,
      item: { id: this.messageItemId, type: 'message', status: 'completed', role: 'assistant', content },
    });
  }

  private messageContent(): Array<Record<string, unknown>> {
    const content: Array<{ contentIndex: number; part: Record<string, unknown> }> = [];
    if (this.textStarted && this.textContentIndex !== null) {
      content.push({
        contentIndex: this.textContentIndex,
        part: { type: 'output_text', text: this.text, annotations: this.uniqueAnnotations() },
      });
    }
    if (this.refusalStarted && this.refusalContentIndex !== null) {
      content.push({
        contentIndex: this.refusalContentIndex,
        part: { type: 'refusal', refusal: this.refusal },
      });
    }
    return content.sort((a, b) => a.contentIndex - b.contentIndex).map((entry) => entry.part);
  }

  private closeTools(out: unknown[]): void {
    for (const state of [...this.tools.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      if (state.done) continue;
      this.addToolWhenReady(state, out, true);
      state.done = true;
      const item = this.toolItem(state, 'completed');
      const kind = this.toolContext?.lookupChatName(state.name)?.kind;
      if (kind === 'custom') {
        const input = customInput(state.arguments);
        if (input) out.push({
          type: 'response.custom_tool_call_input.delta',
          response_id: this.responseId,
          item_id: state.itemId,
          output_index: state.outputIndex,
          delta: input,
        });
        out.push({
          type: 'response.custom_tool_call_input.done',
          response_id: this.responseId,
          item_id: state.itemId,
          output_index: state.outputIndex,
          input,
        });
      } else if (kind !== 'tool_search') {
        out.push({
          type: 'response.function_call_arguments.done',
          response_id: this.responseId,
          item_id: state.itemId,
          output_index: state.outputIndex,
          arguments: state.arguments,
        });
      }
      out.push({
        type: 'response.output_item.done',
        response_id: this.responseId,
        output_index: state.outputIndex,
        item,
      });
    }
  }

  private closeOpenItems(out: unknown[]): void {
    for (const reasoning of this.reasoningItems) this.closeReasoning(reasoning, out);
    this.closeMessage(out);
    this.closeTools(out);
  }

  private complete(reason: string, out: unknown[]): void {
    if (this.terminal) return;
    this.closeOpenItems(out);
    this.terminal = true;
    const incomplete = reason === 'length' || reason === 'content_filter';
    out.push({
      type: incomplete ? 'response.incomplete' : 'response.completed',
      response: this.responseObject(
        incomplete ? 'incomplete' : 'completed',
        incomplete
          ? { incomplete_details: { reason: reason === 'length' ? 'max_output_tokens' : 'content_filter' } }
          : {},
      ),
    });
  }

  private uniqueAnnotations(): ResponseAnnotation[] {
    const seen = new Set<string>();
    return this.annotations.filter((annotation) => {
      const key = `${annotation.url}\0${annotation.start_index}\0${annotation.end_index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private responseObject(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const items: Array<{ outputIndex: number; item: Record<string, unknown> }> = [];
    for (const reasoning of this.reasoningItems) {
      if (reasoning.done) {
        items.push({
          outputIndex: reasoning.outputIndex,
          item: { id: reasoning.itemId, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning.text }] },
        });
      }
    }
    if (this.messageDone && this.messageOutputIndex !== null) {
      items.push({
        outputIndex: this.messageOutputIndex,
        item: {
          id: this.messageItemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: this.messageContent(),
        },
      });
    }
    for (const state of this.tools.values()) {
      if (state.done) items.push({ outputIndex: state.outputIndex, item: this.toolItem(state, 'completed') });
    }
    const output = items.sort((a, b) => a.outputIndex - b.outputIndex).map((entry) => entry.item);
    const cachedTokens = numberField(
      this.usage?.prompt_tokens_details?.cached_tokens
        ?? this.usage?.input_tokens_details?.cached_tokens
        ?? this.usage?.prompt_cache_hit_tokens,
    );
    const reportedInputTokens = this.usage?.prompt_tokens ?? this.usage?.input_tokens;
    const inputTokens = reportedInputTokens === undefined
      ? numberField(this.usage?.prompt_cache_miss_tokens) + cachedTokens
      : numberField(reportedInputTokens);
    const outputTokens = numberField(this.usage?.completion_tokens ?? this.usage?.output_tokens);
    const usage = this.usage || this.zeroUsageOnMissing
      ? {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: numberField(this.usage?.total_tokens) || inputTokens + outputTokens,
          input_tokens_details: {
            cached_tokens: cachedTokens,
          },
          output_tokens_details: {
            reasoning_tokens: numberField(
              this.usage?.completion_tokens_details?.reasoning_tokens
                ?? this.usage?.output_tokens_details?.reasoning_tokens,
            ),
          },
        }
      : undefined;
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.created,
      status,
      model: this.model,
      output,
      ...(this.serviceTier ? { service_tier: this.serviceTier } : {}),
      ...(usage ? { usage } : {}),
      ...extra,
    };
  }
}
