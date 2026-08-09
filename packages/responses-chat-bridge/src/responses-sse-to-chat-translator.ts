/**
 * OpenAI Responses SSE → Chat Completions(chat-sse-translator.ts 的**反向**)。
 *
 * 用途:对外「通用 OpenAI Chat Completions 端点」把 Cindy `/responses` 回来的 Responses SSE
 * 事件流译回标准 Chat `chat.completion.chunk`(流式)或聚合成单个 `chat.completion`
 * (`stream:false`)。消费的事件词表以 `ChatSseTranslator` 的**产出**为基准:
 *   response.created / response.in_progress
 *   response.output_item.added (item.type: message / reasoning / function_call / ...)
 *   response.output_text.delta / response.reasoning_summary_text.delta
 *   response.function_call_arguments.delta / .done
 *   response.output_item.done
 *   response.completed / response.incomplete / response.failed
 *
 * 每次 `push(event)` 返回本次应写出的 Chat chunk 数组;`finish()` 补终止 chunk;
 * `fail(message)` 产出 Chat error 帧。非流式路径无视返回的 chunk,末尾调 `aggregate()`。
 */

export interface ResponsesSseToChatTranslatorOptions {
  /** 缺省 model(上游事件里没带 model 时用)。 */
  model?: string;
  /** 是否在流末尾追加 usage-only chunk(对应 chat 的 stream_options.include_usage)。 */
  includeUsage?: boolean;
}

interface ToolCallState {
  chatIndex: number;
  outputIndex: number;
  id: string;
  name: string;
  args: string;
}

type ChatFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class ResponsesSseToChatTranslator {
  private readonly fallbackModel: string;
  private readonly includeUsage: boolean;

  private responseId = '';
  private model: string;
  private created = 0;
  private roleEmitted = false;
  private terminal = false;
  private nextToolIndex = 0;

  private text = '';
  private reasoning = '';
  private pendingFinish: ChatFinishReason | null = null;
  private usage: Record<string, unknown> | null = null;

  private readonly toolsByOutputIndex = new Map<number, ToolCallState>();
  private readonly outputIndexByItemId = new Map<string, number>();

  constructor(options: ResponsesSseToChatTranslatorOptions = {}) {
    this.fallbackModel = options.model ?? '';
    this.model = this.fallbackModel;
    this.includeUsage = options.includeUsage ?? false;
  }

  /** 消费一个 Responses SSE 事件,返回本次要写出的 Chat chunk 列表(非流式可忽略)。 */
  push(event: unknown): Array<Record<string, unknown>> {
    if (this.terminal || !isPlainObject(event)) return [];
    const type = event.type;
    const out: Array<Record<string, unknown>> = [];

    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        this.absorbResponseMeta(event.response);
        this.ensureRoleChunk(out);
        break;
      }
      case 'response.output_item.added': {
        const item = event.item;
        if (isPlainObject(item) && item.type === 'function_call') {
          this.startToolCall(numberField(event.output_index), item, out);
        }
        break;
      }
      case 'response.output_text.delta': {
        const delta = stringField(event.delta);
        if (delta) {
          this.text += delta;
          this.ensureRoleChunk(out);
          out.push(this.chunk({ content: delta }));
        }
        break;
      }
      case 'response.reasoning_summary_text.delta': {
        const delta = stringField(event.delta);
        if (delta) {
          this.reasoning += delta;
          this.ensureRoleChunk(out);
          out.push(this.chunk({ reasoning_content: delta }));
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const state = this.resolveToolState(event.item_id, event.output_index);
        const delta = stringField(event.delta);
        if (state && delta) {
          state.args += delta;
          out.push(this.chunk({
            tool_calls: [{ index: state.chatIndex, function: { arguments: delta } }],
          }));
        }
        break;
      }
      case 'response.function_call_arguments.done': {
        const state = this.resolveToolState(event.item_id, event.output_index);
        const full = stringField(event.arguments);
        // 只在此前完全没收到过增量参数时补发一次完整参数(某些上游只发 .done)。
        if (state && full && state.args.length === 0) {
          state.args = full;
          out.push(this.chunk({
            tool_calls: [{ index: state.chatIndex, function: { arguments: full } }],
          }));
        }
        break;
      }
      case 'response.output_item.done': {
        const item = event.item;
        if (isPlainObject(item) && item.type === 'function_call') {
          this.finalizeToolFromItem(numberField(event.output_index), item, out);
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        this.absorbResponseMeta(event.response);
        const reason: ChatFinishReason = type === 'response.incomplete'
          ? this.incompleteReason(event.response)
          : this.toolsByOutputIndex.size > 0 ? 'tool_calls' : 'stop';
        this.pendingFinish = reason;
        this.markComplete(out);
        break;
      }
      case 'response.failed': {
        return this.fail(this.failureMessage(event.response));
      }
      default:
        break;
    }

    return out;
  }

  /** 流结束时补终止 chunk(正常路径已在 response.completed 里终止,此处兜底)。 */
  finish(): Array<Record<string, unknown>> {
    if (this.terminal) return [];
    const out: Array<Record<string, unknown>> = [];
    if (!this.pendingFinish) {
      this.pendingFinish = this.toolsByOutputIndex.size > 0 ? 'tool_calls' : 'stop';
    }
    this.markComplete(out);
    return out;
  }

  /** 中途失败:产出一个 Chat error 帧(尽力而为,上游可能已经开始流)。 */
  fail(message: string): Array<Record<string, unknown>> {
    if (this.terminal) return [];
    this.terminal = true;
    return [{
      error: {
        message: message || 'upstream responses stream failed',
        type: 'upstream_error',
        code: null,
      },
    }];
  }

  /** 是否已产出终止 chunk。 */
  get isTerminal(): boolean {
    return this.terminal;
  }

  /** 非流式:把累积状态聚合成单个 chat.completion 对象。 */
  aggregate(): Record<string, unknown> {
    const message: Record<string, unknown> = { role: 'assistant' };
    const toolCalls = [...this.toolsByOutputIndex.values()]
      .sort((a, b) => a.chatIndex - b.chatIndex)
      .map((state) => ({
        id: state.id,
        type: 'function' as const,
        function: { name: state.name, arguments: state.args },
      }));
    message.content = this.text.length > 0 ? this.text : null;
    if (this.reasoning.length > 0) message.reasoning_content = this.reasoning;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    const completion: Record<string, unknown> = {
      id: this.chatId(),
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        message,
        finish_reason: this.pendingFinish ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      }],
    };
    const usage = this.chatUsage();
    if (usage) completion.usage = usage;
    return completion;
  }

  private absorbResponseMeta(response: unknown): void {
    if (!isPlainObject(response)) return;
    if (!this.responseId && typeof response.id === 'string' && response.id) {
      this.responseId = response.id;
    }
    if (typeof response.model === 'string' && response.model) this.model = response.model;
    if (typeof response.created_at === 'number' && response.created_at) {
      this.created = response.created_at;
    }
    if (isPlainObject(response.usage)) this.usage = response.usage;
  }

  private ensureRoleChunk(out: Array<Record<string, unknown>>): void {
    if (this.roleEmitted) return;
    this.roleEmitted = true;
    out.push(this.chunk({ role: 'assistant' }));
  }

  private startToolCall(
    outputIndex: number,
    item: Record<string, unknown>,
    out: Array<Record<string, unknown>>,
  ): ToolCallState {
    const existing = this.toolsByOutputIndex.get(outputIndex);
    if (existing) return existing;
    const chatIndex = this.nextToolIndex++;
    const id = stringField(item.call_id) || `call_${this.responseId || 'bridge'}_${outputIndex}`;
    const state: ToolCallState = {
      chatIndex,
      outputIndex,
      id,
      name: stringField(item.name),
      args: '',
    };
    this.toolsByOutputIndex.set(outputIndex, state);
    if (typeof item.id === 'string' && item.id) this.outputIndexByItemId.set(item.id, outputIndex);
    this.ensureRoleChunk(out);
    out.push(this.chunk({
      tool_calls: [{
        index: chatIndex,
        id: state.id,
        type: 'function',
        function: { name: state.name, arguments: '' },
      }],
    }));
    return state;
  }

  private finalizeToolFromItem(
    outputIndex: number,
    item: Record<string, unknown>,
    out: Array<Record<string, unknown>>,
  ): void {
    let state = this.toolsByOutputIndex.get(outputIndex);
    if (!state) state = this.startToolCall(outputIndex, item, out);
    if (!state.name && stringField(item.name)) state.name = stringField(item.name);
    const full = stringField(item.arguments);
    if (full && state.args.length === 0) {
      state.args = full;
      out.push(this.chunk({
        tool_calls: [{ index: state.chatIndex, function: { arguments: full } }],
      }));
    }
  }

  private resolveToolState(itemId: unknown, outputIndex: unknown): ToolCallState | undefined {
    if (typeof itemId === 'string' && this.outputIndexByItemId.has(itemId)) {
      return this.toolsByOutputIndex.get(this.outputIndexByItemId.get(itemId)!);
    }
    if (typeof outputIndex === 'number') return this.toolsByOutputIndex.get(outputIndex);
    return undefined;
  }

  private markComplete(out: Array<Record<string, unknown>>): void {
    if (this.terminal) return;
    this.terminal = true;
    this.ensureRoleChunk(out);
    out.push(this.chunk({}, this.pendingFinish ?? 'stop'));
    if (this.includeUsage) {
      const usage = this.chatUsage();
      if (usage) {
        out.push({
          id: this.chatId(),
          object: 'chat.completion.chunk',
          created: this.created,
          model: this.model,
          choices: [],
          usage,
        });
      }
    }
  }

  private incompleteReason(response: unknown): ChatFinishReason {
    if (isPlainObject(response) && isPlainObject(response.incomplete_details)) {
      const reason = response.incomplete_details.reason;
      if (reason === 'max_output_tokens') return 'length';
      if (reason === 'content_filter') return 'content_filter';
    }
    return 'length';
  }

  private failureMessage(response: unknown): string {
    if (isPlainObject(response) && isPlainObject(response.error)) {
      const message = response.error.message;
      if (typeof message === 'string' && message) return message;
    }
    return 'upstream responses stream failed';
  }

  private chatId(): string {
    return this.responseId ? `chatcmpl-${this.responseId}` : 'chatcmpl-bridge';
  }

  private chunk(
    delta: Record<string, unknown>,
    finishReason: ChatFinishReason | null = null,
  ): Record<string, unknown> {
    return {
      id: this.chatId(),
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }

  private chatUsage(): Record<string, unknown> | null {
    const u = this.usage;
    if (!u) return null;
    const inputDetails = isPlainObject(u.input_tokens_details)
      ? u.input_tokens_details
      : isPlainObject(u.prompt_tokens_details) ? u.prompt_tokens_details : undefined;
    const outputDetails = isPlainObject(u.output_tokens_details)
      ? u.output_tokens_details
      : isPlainObject(u.completion_tokens_details) ? u.completion_tokens_details : undefined;
    const prompt = numberField(u.input_tokens ?? u.prompt_tokens);
    const completion = numberField(u.output_tokens ?? u.completion_tokens);
    const total = numberField(u.total_tokens) || prompt + completion;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
      prompt_tokens_details: { cached_tokens: numberField(inputDetails?.cached_tokens) },
      completion_tokens_details: { reasoning_tokens: numberField(outputDetails?.reasoning_tokens) },
    };
  }
}
