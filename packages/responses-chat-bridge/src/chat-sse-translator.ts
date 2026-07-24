import { createHash } from 'node:crypto';

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

interface UsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
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

/**
 * Chat Completions SSE → OpenAI Responses SSE 状态机。
 *
 * tool call 以 Chat 的 `index` 为 identity；id/name/arguments 可以在不同 chunk 抵达，
 * translator 会为每个 index 独立累积，避免并行工具参数串线。
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
  private text = '';
  private pendingFinishReason: string | null = null;
  private sawTerminalMarker = false;
  // reasoning(思考)通道:DeepSeek/GLM 等 reasoner 在 delta.reasoning_content 里流式吐思考,
  // 映射成 Responses reasoning summary 事件(reasoner 必须排在 message 之前)。
  private reasoningOutputIndex: number | null = null;
  private reasoningItemId = '';
  private reasoningStarted = false;
  private reasoningDone = false;
  private reasoningText = '';
  private readonly tools = new Map<number, ToolState>();
  private usage: UsageShape | undefined;

  constructor(model: string) {
    this.model = model;
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
    this.ensureStarted(out);

    // 部分 Chat 上游在 `200 text/event-stream` 里用顶层 `error` 帧报错(而非 HTTP 非 2xx)。
    // 没有 choices,若不识别就只会被当成空帧,最终 finish() 发出"成功但空"的 completed,
    // Codex 会把失败当成功轮。检测到顶层 error → 直接走 fail() 终态,把错误如实透出。
    if (isPlainObject(raw.error)) {
      const message = stringField((raw.error as { message?: unknown }).message)
        || 'provider returned an error event';
      for (const event of this.fail(message)) out.push(event);
      return out;
    }

    if (isPlainObject(raw.usage)) this.usage = raw.usage as UsageShape;
    const choices = Array.isArray(raw.choices) ? raw.choices : [];
    for (const choiceValue of choices) {
      if (!isPlainObject(choiceValue)) continue;
      const delta = isPlainObject(choiceValue.delta) ? choiceValue.delta : {};
      // 思考内容先于正文:reasoner 在 delta.reasoning_content 流式吐思考。
      const reasoning = stringField(delta.reasoning_content);
      if (reasoning) {
        this.ensureReasoning(out);
        this.reasoningText += reasoning;
        out.push({
          type: 'response.reasoning_summary_text.delta',
          item_id: this.reasoningItemId,
          output_index: this.reasoningOutputIndex,
          summary_index: 0,
          delta: reasoning,
        });
      }
      const content = stringField(delta.content);
      if (content) {
        this.ensureMessage(out);
        this.text += content;
        out.push({
          type: 'response.output_text.delta',
          // item_id 必填:codex 靠它把 delta 绑定到已 added 的 message output_item 做**增量渲染**;
          // 缺了 codex 无法增量,只能等 output_item.done 的完整 text 一次性渲染(表现为"非流式")。
          item_id: this.messageItemId,
          response_id: this.responseId,
          output_index: this.messageOutputIndex,
          content_index: 0,
          delta: content,
        });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) this.consumeToolDelta(toolCall, out);
      }
      const finishReason = typeof choiceValue.finish_reason === 'string' ? choiceValue.finish_reason : null;
      if (finishReason) {
        this.pendingFinishReason = finishReason;
        this.sawTerminalMarker = true;
      }
    }
    return out;
  }

  /** Mark the upstream SSE stream as having delivered its explicit terminal marker. */
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
    this.complete(this.pendingFinishReason ?? 'stop', out);
    return out;
  }

  fail(message: string): unknown[] {
    if (this.terminal) return [];
    const out: unknown[] = [];
    this.ensureStarted(out);
    this.closeOpenItems(out);
    this.terminal = true;
    out.push({
      type: 'response.failed',
      response: this.responseObject('failed', {
        error: { code: 'upstream_stream_error', message },
      }),
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

  private ensureReasoning(out: unknown[]): void {
    if (this.reasoningStarted) return;
    this.reasoningStarted = true;
    this.reasoningOutputIndex = this.nextOutputIndex++;
    this.reasoningItemId = deterministicId('rs', this.responseId, this.reasoningOutputIndex);
    out.push({
      type: 'response.output_item.added',
      response_id: this.responseId,
      output_index: this.reasoningOutputIndex,
      item: { id: this.reasoningItemId, type: 'reasoning', status: 'in_progress', summary: [] },
    });
    out.push({
      type: 'response.reasoning_summary_part.added',
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
  }

  private closeReasoning(out: unknown[]): void {
    if (!this.reasoningStarted || this.reasoningDone || this.reasoningOutputIndex === null) return;
    this.reasoningDone = true;
    out.push({
      type: 'response.reasoning_summary_text.done',
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      text: this.reasoningText,
    });
    out.push({
      type: 'response.reasoning_summary_part.done',
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: this.reasoningText },
    });
    // reasoning summary item 完成态刻意不带 status(对齐参考实现)。
    out.push({
      type: 'response.output_item.done',
      response_id: this.responseId,
      output_index: this.reasoningOutputIndex,
      item: { id: this.reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: this.reasoningText }] },
    });
  }

  private ensureMessage(out: unknown[]): void {
    if (this.messageStarted) return;
    // reasoning 必须在 message 之前完整关闭(参考:reasoning precedes message)。
    this.closeReasoning(out);
    this.messageStarted = true;
    this.messageOutputIndex = this.nextOutputIndex++;
    this.messageItemId = deterministicId('msg', this.responseId, this.messageOutputIndex);
    const item = { id: this.messageItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
    out.push({ type: 'response.output_item.added', response_id: this.responseId, output_index: this.messageOutputIndex, item });
    out.push({
      type: 'response.content_part.added',
      response_id: this.responseId,
      item_id: this.messageItemId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  private consumeToolDelta(raw: unknown, out: unknown[]): void {
    if (!isPlainObject(raw) || typeof raw.index !== 'number') return;
    const index = raw.index;
    let state = this.tools.get(index);
    if (!state) {
      const outputIndex = this.nextOutputIndex++;
      const callId = stringField(raw.id) || deterministicId('call', this.responseId, index);
      state = {
        outputIndex,
        itemId: deterministicId('fc', this.responseId, index),
        callId,
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
    const fn = isPlainObject(raw.function) ? raw.function : {};
    const name = stringField(fn.name);
    if (name && !state.added) state.name += name;
    if (!state.added && state.name) {
      state.added = true;
      out.push({
        type: 'response.output_item.added',
        response_id: this.responseId,
        output_index: state.outputIndex,
        item: {
          id: state.itemId,
          type: 'function_call',
          status: 'in_progress',
          name: state.name,
          call_id: state.callId,
          arguments: '',
        },
      });
      const bufferedArgs = state.arguments.slice(state.emittedArgumentsLength);
      if (bufferedArgs) {
        state.emittedArgumentsLength = state.arguments.length;
        out.push({
          type: 'response.function_call_arguments.delta',
          response_id: this.responseId,
          item_id: state.itemId,
          output_index: state.outputIndex,
          delta: bufferedArgs,
        });
      }
    }
    const args = stringField(fn.arguments);
    if (args) {
      state.arguments += args;
      // Some providers stream argument bytes before the function name. Keep the
      // bytes buffered so the first output_item.added event has a usable name.
      if (state.added) {
        const delta = state.arguments.slice(state.emittedArgumentsLength);
        state.emittedArgumentsLength = state.arguments.length;
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

  private closeMessage(out: unknown[]): void {
    if (!this.messageStarted || this.messageDone || this.messageOutputIndex === null) return;
    this.messageDone = true;
    out.push({
      type: 'response.output_text.done',
      response_id: this.responseId,
      item_id: this.messageItemId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      text: this.text,
    });
    const content = [{ type: 'output_text', text: this.text, annotations: [] }];
    out.push({
      type: 'response.content_part.done',
      response_id: this.responseId,
      item_id: this.messageItemId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      part: content[0],
    });
    out.push({
      type: 'response.output_item.done',
      response_id: this.responseId,
      output_index: this.messageOutputIndex,
      item: { id: this.messageItemId, type: 'message', status: 'completed', role: 'assistant', content },
    });
  }

  private closeTools(out: unknown[]): void {
    for (const state of [...this.tools.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      if (state.done) continue;
      state.done = true;
      if (!state.added) {
        state.added = true;
        out.push({
          type: 'response.output_item.added',
          response_id: this.responseId,
          output_index: state.outputIndex,
          item: {
            id: state.itemId,
            type: 'function_call',
            status: 'in_progress',
            name: state.name,
            call_id: state.callId,
            arguments: '',
          },
        });
      }
      out.push({
        type: 'response.function_call_arguments.done',
        response_id: this.responseId,
        item_id: state.itemId,
        output_index: state.outputIndex,
        arguments: state.arguments,
      });
      out.push({
        type: 'response.output_item.done',
        response_id: this.responseId,
        output_index: state.outputIndex,
        item: {
          id: state.itemId,
          type: 'function_call',
          status: 'completed',
          name: state.name,
          call_id: state.callId,
          arguments: state.arguments,
        },
      });
    }
  }

  private closeOpenItems(out: unknown[]): void {
    // reasoning 先于 message 关闭(顺序不变量);message 若已在 ensureMessage 里关过 reasoning 则 no-op。
    this.closeReasoning(out);
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
      response: this.responseObject(incomplete ? 'incomplete' : 'completed', incomplete
        ? { incomplete_details: { reason: reason === 'length' ? 'max_output_tokens' : 'content_filter' } }
        : {}),
    });
  }

  private responseObject(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    // Responses 协议里 output 数组位置 = output index（item 不带显式 index 字段）。
    // message 与 function_call 必须**统一按 outputIndex 排序**，不能无条件把 message 排在前面——
    // 否则模型先发工具调用、后补正文时（agentic 第三方模型常见），回放为下一轮 input 的顺序会颠倒。
    const items: Array<{ outputIndex: number; item: Record<string, unknown> }> = [];
    if (this.reasoningDone && this.reasoningOutputIndex !== null) {
      items.push({
        outputIndex: this.reasoningOutputIndex,
        // reasoning summary item 完成态不带 status(对齐参考实现)。
        item: { id: this.reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: this.reasoningText }] },
      });
    }
    if (this.messageDone && this.messageOutputIndex !== null) {
      items.push({
        outputIndex: this.messageOutputIndex,
        item: {
          id: this.messageItemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: this.text, annotations: [] }],
        },
      });
    }
    for (const state of this.tools.values()) {
      if (!state.done) continue;
      items.push({
        outputIndex: state.outputIndex,
        item: {
          id: state.itemId,
          type: 'function_call',
          status: 'completed',
          name: state.name,
          call_id: state.callId,
          arguments: state.arguments,
        },
      });
    }
    const output = items.sort((a, b) => a.outputIndex - b.outputIndex).map((entry) => entry.item);
    const inputTokens = numberField(this.usage?.prompt_tokens);
    const outputTokens = numberField(this.usage?.completion_tokens);
    const usage = this.usage ? {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: numberField(this.usage.total_tokens) || inputTokens + outputTokens,
      input_tokens_details: {
        cached_tokens: numberField(this.usage.prompt_tokens_details?.cached_tokens),
      },
      output_tokens_details: {
        reasoning_tokens: numberField(this.usage.completion_tokens_details?.reasoning_tokens),
      },
    } : undefined;
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.created,
      status,
      model: this.model,
      output,
      ...(usage ? { usage } : {}),
      ...extra,
    };
  }
}
