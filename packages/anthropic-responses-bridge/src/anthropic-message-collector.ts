interface ContentBlockState {
  index: number;
  block: Record<string, unknown>;
  inputJson: string;
}

export type AnthropicMessageCollectionResult =
  | { ok: true; message: Record<string, unknown> }
  | { ok: false; error: { type: string; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 把已翻译的 Anthropic SSE 事件收集成 Messages API 的非流式 Message JSON。
 *
 * 非流式 fallback 必须拿到单个完整 Message,不能直接收到 SSE。收集器复用流式翻译器的
 * 事件输出,保证 text / thinking / tool_use 的排序和 usage 映射只有一套事实源。
 */
export class AnthropicMessageCollector {
  private message: Record<string, unknown> | null = null;
  private readonly blocks = new Map<number, ContentBlockState>();
  private stopped = false;
  private error: { type: string; message: string } | null = null;

  push(event: { event: string; data: Record<string, unknown> }): void {
    if (this.error || this.stopped) return;

    switch (event.event) {
      case 'message_start':
        this.onMessageStart(event.data);
        break;
      case 'content_block_start':
        this.onBlockStart(event.data);
        break;
      case 'content_block_delta':
        this.onBlockDelta(event.data);
        break;
      case 'content_block_stop':
        this.onBlockStop(event.data);
        break;
      case 'message_delta':
        this.onMessageDelta(event.data);
        break;
      case 'message_stop':
        this.stopped = true;
        break;
      case 'error': {
        const error = isRecord(event.data.error) ? event.data.error : {};
        this.error = {
          type: asString(error.type) || 'api_error',
          message: asString(error.message) || 'upstream response failed',
        };
        break;
      }
      default:
        break;
    }
  }

  finish(): AnthropicMessageCollectionResult {
    if (this.error) return { ok: false, error: this.error };
    if (!this.message || !this.stopped) {
      return {
        ok: false,
        error: {
          type: 'api_error',
          message: 'upstream response did not produce a complete Anthropic message',
        },
      };
    }

    const content = [...this.blocks.values()]
      .sort((a, b) => a.index - b.index)
      .map((state) => state.block);
    // 非流式调用方需要一个可用的 Message:零 content block 的「成功」响应正是 Claude Code
    // 报 "empty or malformed response" 的形态,按上游错误如实上报而不是回一个空 message。
    if (content.length === 0) {
      return {
        ok: false,
        error: { type: 'api_error', message: 'upstream response contained no content blocks' },
      };
    }
    return { ok: true, message: { ...this.message, content } };
  }

  private onMessageStart(data: Record<string, unknown>): void {
    const message = isRecord(data.message) ? data.message : null;
    if (!message) {
      this.error = { type: 'api_error', message: 'upstream response produced an invalid message_start' };
      return;
    }
    this.message = {
      ...message,
      type: 'message',
      role: 'assistant',
      content: [],
    };
  }

  private onBlockStart(data: Record<string, unknown>): void {
    const index = typeof data.index === 'number' ? data.index : -1;
    const contentBlock = isRecord(data.content_block) ? data.content_block : null;
    if (index < 0 || !contentBlock || this.blocks.has(index)) {
      this.error = { type: 'api_error', message: 'upstream response produced an invalid content block' };
      return;
    }
    this.blocks.set(index, {
      index,
      block: { ...contentBlock },
      inputJson: '',
    });
  }

  private onBlockDelta(data: Record<string, unknown>): void {
    const index = typeof data.index === 'number' ? data.index : -1;
    const state = this.blocks.get(index);
    const delta = isRecord(data.delta) ? data.delta : null;
    if (!state || !delta) {
      this.error = { type: 'api_error', message: 'upstream response produced an orphan content delta' };
      return;
    }

    switch (delta.type) {
      case 'text_delta':
        state.block.text = asString(state.block.text) + asString(delta.text);
        break;
      case 'thinking_delta':
        state.block.thinking = asString(state.block.thinking) + asString(delta.thinking);
        break;
      case 'signature_delta':
        state.block.signature = asString(state.block.signature) + asString(delta.signature);
        break;
      case 'input_json_delta':
        state.inputJson += asString(delta.partial_json);
        break;
      default:
        break;
    }
  }

  private onBlockStop(data: Record<string, unknown>): void {
    const index = typeof data.index === 'number' ? data.index : -1;
    const state = this.blocks.get(index);
    if (!state) {
      this.error = { type: 'api_error', message: 'upstream response stopped an unknown content block' };
      return;
    }
    if (state.block.type !== 'tool_use') return;
    if (!state.inputJson) {
      state.block.input = isRecord(state.block.input) ? state.block.input : {};
      return;
    }
    try {
      state.block.input = JSON.parse(state.inputJson) as unknown;
    } catch {
      this.error = { type: 'api_error', message: 'upstream response produced malformed tool arguments' };
    }
  }

  private onMessageDelta(data: Record<string, unknown>): void {
    if (!this.message) {
      this.error = { type: 'api_error', message: 'upstream response produced message_delta before message_start' };
      return;
    }
    const delta = isRecord(data.delta) ? data.delta : {};
    if ('stop_reason' in delta) this.message.stop_reason = delta.stop_reason ?? null;
    if ('stop_sequence' in delta) this.message.stop_sequence = delta.stop_sequence ?? null;
    if (isRecord(data.usage)) {
      const initialUsage = isRecord(this.message.usage) ? this.message.usage : {};
      this.message.usage = { ...initialUsage, ...data.usage };
    }
  }
}
