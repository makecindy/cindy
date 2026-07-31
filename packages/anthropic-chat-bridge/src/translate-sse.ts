/**
 * 流式响应翻译 —— OpenAI Chat Completions SSE → Anthropic Messages SSE(有状态)。
 *
 * 用法:handler 逐条 parse 上游 `data:` 行成对象,喂给 `push(chunk)`,拿回 0..N 条
 * Anthropic SSE 事件顺序写回客户端。上游流结束后调 `finish()` 兜底收尾。
 *
 * Chat Completions SSE 形态(无 event 行,纯 data 帧):
 *   {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}
 *   {"choices":[{"delta":{"content":"Hello"}}]}
 *   {"choices":[{"delta":{"reasoning_content":"思考..."}}]}            ← DeepSeek/Kimi 扩展
 *   {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function",
 *     "function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}
 *   {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]}}]}
 *   {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
 *   {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":12}}   ← include_usage 尾帧
 *   data: [DONE]
 *
 * 块映射:
 *   content(delta 流)           → text 块(text_delta 流,惰性开块)
 *   reasoning_content(delta 流) → thinking 块(thinking_delta 流,惰性开块)
 *   tool_calls(按 index 累积)   → tool_use 块(**延迟到流尾一次性输出** —— 见下)
 *   finish_reason               → message_delta.stop_reason
 *   usage(尾帧)                 → message_delta.usage
 *
 * 单开块不变量(Anthropic SSE 硬约定):同一时刻至多一个 content block 打开,块必须
 * 严格顺序 start→delta→stop。text / thinking 块**可打断**(Anthropic 允许同一消息内
 * 多个同类型块;上游 reasoning 段严格先于 content 段,实际很少触发)。
 *
 * tool_calls 为什么延迟到流尾一次性输出:Chat 流里没有「某 tool 的 arguments 流结束」
 * 的显式信号 —— 多工具并行时 arguments 交错到达(finish_reason='tool_calls' 才宣告
 * 全部结束)。若逐 delta 转发,两个 tool_use 块会交错打开,违反单开块不变量,且被提前
 * 关闭的 tool_use 会带残缺 arguments(Claude Code 拿到残缺 JSON 执行工具)。累积到
 * finish_reason / 流结束再按 index 顺序输出完整块,天然满足「tool_use 块完整」语义,
 * 代价仅是工具调用非逐字流式(Claude Code 对 tool_use 的展示本就是块级的)。
 *
 * 块内容惰性开块:空块 / 纯空白块会被 Anthropic 回放 400("text content blocks must
 * contain non-whitespace text"),text / thinking 块只在首个含非空白字符的 delta 到达
 * 时打开,此前空白先缓冲;全程纯空白则整块不落地。
 */

import { mapUsage } from './usage.js';

/** 一条待写回客户端的 Anthropic SSE 事件。 */
export interface AnthropicSseEvent {
  event: string;
  data: Record<string, unknown>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** delta 里的可见思考文本(DeepSeek/Kimi 的 reasoning_content;其它厂商变体兜底)。 */
function extractReasoning(delta: Record<string, unknown>): string {
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_details']) {
    const raw = delta[key];
    if (typeof raw === 'string' && raw) return raw;
    if (Array.isArray(raw)) {
      const text = raw
        .map((part) => (asRecord(part).type === 'text' ? str(asRecord(part).text) : ''))
        .join('');
      if (text) return text;
    }
  }
  return '';
}

interface ToolCallState {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

interface OpenBlockState {
  kind: 'text' | 'thinking';
  blockIndex: number;
}

export class AnthropicSseTranslator {
  private messageStarted = false;
  private finished = false;
  private nextBlockIndex = 0;
  private hasToolUse = false;
  private pendingFinishReason: string | null = null;
  private sawTerminalMarker = false;
  private usage: unknown | undefined;
  /** 累积的 tool_calls(按 index 升序,延迟到流尾输出)。 */
  private readonly tools = new Map<number, ToolCallState>();
  /** 当前打开的 text / thinking 块(null = 无块打开)。 */
  private open: OpenBlockState | null = null;
  private messageId = '';
  private model: string;
  private readonly modelPinned: boolean;
  /** text / thinking 块惰性开块前的空白缓冲。 */
  private pendingText = '';
  private pendingThinking = '';

  constructor(model: string) {
    this.model = model;
    this.modelPinned = model.length > 0;
  }

  /** 喂一条上游 Chat Completions chunk,返回要写回客户端的 Anthropic 事件(可能 0 条)。 */
  push(raw: unknown): AnthropicSseEvent[] {
    if (this.finished) return [];
    const chunk = asRecord(raw);
    const out: AnthropicSseEvent[] = [];

    // 首块回显 id/model 用于 message_start 回显(wire model 固定用构造值,不被覆盖)。
    const rawId = str(chunk.id);
    if (rawId && !this.messageStarted) this.messageId = rawId;

    // 流内错误帧(无 choices,带 error 对象)→ turn 级错误。
    const error = asRecord(chunk.error);
    if (isPlainObject(chunk) && chunk.error && typeof chunk.error === 'object') {
      const message = str(error.message) || 'upstream returned an error event';
      return this.fail(message);
    }

    if (chunk.usage && typeof chunk.usage === 'object') this.usage = chunk.usage;

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    // n 恒为 1(请求侧不设 n),只处理第一个 choice。
    const choice = choices[0];
    if (choice && typeof choice === 'object') {
      const c = asRecord(choice);
      const delta = asRecord(c.delta);

      const reasoning = extractReasoning(delta);
      if (reasoning) {
        for (const ev of this.pushThinking(reasoning)) out.push(ev);
      }
      const content = str(delta.content);
      if (content) {
        for (const ev of this.pushText(content)) out.push(ev);
      }
      if (Array.isArray(delta.tool_calls)) {
        this.collectToolCalls(delta.tool_calls);
      }
      const finishReason = str(c.finish_reason);
      if (finishReason) {
        this.pendingFinishReason = finishReason;
        this.sawTerminalMarker = true;
      }
    }
    return out;
  }

  /** 收到 `[DONE]` 帧(规范流的正常收尾标记)。 */
  markTerminal(): void {
    this.sawTerminalMarker = true;
  }

  /**
   * 上游流正常结束时的兜底收尾(极少触发 —— 正常路径 finish_reason + [DONE] 已收尾)。
   * requireTerminalMarker:上游 EOF 前未收到任何终止标记时按失败处理(空流 / 静默截断)。
   */
  finish(requireTerminalMarker = false): AnthropicSseEvent[] {
    if (this.finished) return [];
    if (requireTerminalMarker && !this.sawTerminalMarker) {
      return this.fail('upstream SSE stream ended before a terminal marker');
    }
    const out: AnthropicSseEvent[] = [];
    this.ensureMessageStart(out);
    this.closeOpenBlock(out);
    this.emitToolUseBlocks(out);
    const stopReason = this.resolveStopReason();
    const usage = mapUsage(this.usage);
    out.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
        },
      },
    });
    out.push({ event: 'message_stop', data: { type: 'message_stop' } });
    this.finished = true;
    return out;
  }

  /**
   * 上游读流中途失败(reader 抛错 / 流内错误帧)时的收尾:关掉已打开的块 + `error` 事件,
   * **不发** message_delta/message_stop —— 已写出部分内容后再补正常收尾,Claude Code
   * 会把截断响应当成正常完成,上游读取错误被完全掩盖(review 反馈 P1)。已收尾则返回空。
   * 已累积未输出的 tool_use 一并丢弃(断流后工具调用已注定残缺)。
   */
  fail(message: string): AnthropicSseEvent[] {
    if (this.finished) return [];
    const out: AnthropicSseEvent[] = [];
    this.closeOpenBlock(out);
    this.tools.clear();
    out.push({
      event: 'error',
      data: { type: 'error', error: { type: 'api_error', message } },
    });
    this.finished = true;
    return out;
  }

  // ── message_start ──────────────────────────────────────────────────────────
  private ensureMessageStart(out: AnthropicSseEvent[]): void {
    if (this.messageStarted) return;
    this.messageStarted = true;
    out.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: this.messageId || `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          // 回显 wire model(带 bridge 前缀,如 deepseek/deepseek-chat)—— 下游 token
          // 记账靠前缀区分「桥接轮」与其它上游同名裸模型。
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    });
  }

  /**
   * 单开块不变量的执行点:要为**另一个**块输出前,先关掉当前打开的块。text / thinking
   * 块可安全打断(之后再来 delta 走「补开」路径开新块续写,内容不丢)。
   */
  private closeOpenBlock(out: AnthropicSseEvent[]): void {
    if (!this.open) return;
    out.push({
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: this.open.blockIndex },
    });
    this.open = null;
  }

  private openBlock(out: AnthropicSseEvent[], kind: 'text' | 'thinking', blockIndex: number): void {
    this.open = { kind, blockIndex };
    out.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: blockIndex,
        content_block: kind === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' },
      },
    });
  }

  // ── text ───────────────────────────────────────────────────────────────────
  private pushText(delta: string): AnthropicSseEvent[] {
    const out: AnthropicSseEvent[] = [];
    this.ensureMessageStart(out);
    if (this.open?.kind === 'text') {
      out.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: this.open.blockIndex, delta: { type: 'text_delta', text: delta } },
      });
      return out;
    }
    // 换块(thinking → text 或断块续写):开新 text 块。前导空白随首个 delta 一并发出。
    this.closeOpenBlock(out);
    const pending = this.pendingText + delta;
    if (pending.trim().length === 0) {
      this.pendingText = pending;
      return out;
    }
    this.pendingText = '';
    this.openBlock(out, 'text', this.nextBlockIndex++);
    out.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: this.open?.blockIndex ?? 0, delta: { type: 'text_delta', text: pending } },
    });
    return out;
  }

  // ── thinking ───────────────────────────────────────────────────────────────
  private pushThinking(delta: string): AnthropicSseEvent[] {
    const out: AnthropicSseEvent[] = [];
    this.ensureMessageStart(out);
    if (this.open?.kind === 'thinking') {
      out.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: this.open.blockIndex, delta: { type: 'thinking_delta', thinking: delta } },
      });
      return out;
    }
    this.closeOpenBlock(out);
    const pending = this.pendingThinking + delta;
    if (pending.trim().length === 0) {
      this.pendingThinking = pending;
      return out;
    }
    this.pendingThinking = '';
    this.openBlock(out, 'thinking', this.nextBlockIndex++);
    out.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: this.open?.blockIndex ?? 0, delta: { type: 'thinking_delta', thinking: pending } },
    });
    return out;
  }

  // ── tool_calls(累积,流尾输出)────────────────────────────────────────────────
  private collectToolCalls(toolCalls: unknown[]): void {
    for (const [position, rawCall] of toolCalls.entries()) {
      const call = asRecord(rawCall);
      if (!isPlainObject(call)) continue;
      // OpenAI 规范带 index;个别厂商缺失时按数组位置。
      const index = num(call.index);
      const key = typeof call.index === 'number' ? index : position;
      const existing = this.tools.get(key);
      const function_ = asRecord(call.function);
      const id = str(call.id);
      const name = str(function_.name);
      const args = str(function_.arguments);
      if (existing) {
        if (name) existing.name = name;
        if (args) existing.arguments += args;
      } else {
        // 首个 delta 必有 id + name;缺失(厂商不标准)时兜底合成。
        this.tools.set(key, {
          index: key,
          id: id || `call_${key}`,
          name: name || '',
          arguments: args,
        });
      }
    }
  }

  /** 流尾一次性输出全部累积的 tool_use 块(按 index 升序,保证多工具顺序稳定)。 */
  private emitToolUseBlocks(out: AnthropicSseEvent[]): void {
    if (this.tools.size === 0) return;
    const sorted = [...this.tools.values()].sort((a, b) => a.index - b.index);
    for (const tool of sorted) {
      const blockIndex = this.nextBlockIndex++;
      this.hasToolUse = true;
      out.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
        },
      });
      // 完整 arguments 一次性作为单条 input_json_delta 发出(累积式输出,见头注释)。
      if (tool.arguments) {
        out.push({
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: tool.arguments } },
        });
      }
      out.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: blockIndex },
      });
    }
    this.tools.clear();
  }

  // ── 收尾 ────────────────────────────────────────────────────────────────────
  private resolveStopReason(): string {
    const raw = this.pendingFinishReason ?? '';
    switch (raw) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'tool_calls':
        return 'tool_use';
      case 'content_filter':
        // 内容被过滤 ≠ 触顶:保守回落默认,别让 CC 误判成 max_tokens 触发自动续写。
        return this.hasToolUse ? 'tool_use' : 'end_turn';
      default:
        return this.hasToolUse ? 'tool_use' : 'end_turn';
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
