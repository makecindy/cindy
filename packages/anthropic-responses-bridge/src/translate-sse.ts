/**
 * 流式响应翻译 —— OpenAI Responses SSE → Anthropic Messages SSE(有状态)。
 *
 * 用法:server 逐条 parse 上游 `data:` 行成对象,喂给 `push(event)`,拿回 0..N 条
 * Anthropic SSE 事件顺序写回客户端。上游流结束后调 `finish()`:正常 response.completed
 * 已收尾时它是 no-op,否则按流截断发 error(不合成 message_stop)。非流式调用方走
 * `pushJson()` 把整个 Responses JSON 喂进同一状态机。
 *
 * Responses 事件序列(Phase0 探针实测):
 *   response.created → in_progress
 *   → output_item.added(reasoning) → [reasoning_summary_text.delta...] → output_item.done(reasoning, 带 encrypted_content)
 *   → output_item.added(message) → content_part.added → output_text.delta... → content_part.done → output_item.done
 *   → output_item.added(function_call) → function_call_arguments.delta... → .done → output_item.done
 *   → response.completed(带 usage)
 *
 * 块映射:每个 Responses output_item 对应一个 Anthropic content block:
 *   reasoning(有可见 summary) → thinking block(thinking_delta 流 + 末尾 signature_delta=encrypted_content)
 *   reasoning(无可见 summary) → redacted_thinking block(data=encrypted_content,整块在 done 时一次性吐)
 *   message                   → text block(text_delta 流)
 *   function_call             → tool_use block(input_json_delta 流,id=call_id)
 *
 * 单开块不变量(Anthropic SSE 硬约定):同一时刻至多一个 content block 打开,块必须
 * 严格顺序 start→delta→stop。部分上游(实测 xAI grok)会把 message item 挂着不发
 * output_item.done,中间穿插 function_call item —— 若照原序透传就会出现交错块,
 * Claude Code 会把同一个 text 块 flush 两次(UI 正文重复)。整流策略按块类型分两种:
 *   - text 块可安全拆分:要为另一个 item 输出前强制关掉它,之后再来 delta 时按「补开」
 *     路径开新块续写(内容不丢、顺序保持,只是可能拆成多个块);
 *   - tool_use / thinking 块不可拆(tool_use 同 id 不能重开、提前关掉会让 Claude Code
 *     拿残缺 JSON 执行工具;thinking 的 signature 在 item.done 才到、只能挂在打开的块上,
 *     提前关掉会产出回放即丢的无签名 thinking):打开期间其它 item 的事件进 deferred
 *     队列,块正常关闭后回放;tool_use 另在 item.done 时对照完整 arguments 补发缺失尾段。
 *
 * reasoning 往返约定与 translate-request.ts 对称。
 */

import { mapUsage } from './usage.js';

/** 一条待写回客户端的 Anthropic SSE 事件。 */
export interface AnthropicSseEvent {
  event: string;
  data: Record<string, unknown>;
}

type BlockKind = 'thinking' | 'message' | 'function_call';

interface BlockState {
  blockIndex: number;
  kind: BlockKind;
  /** thinking:是否已开块(首个非空白 summary delta 时开);message:是否已开 text 块。 */
  opened: boolean;
  /** function_call:已发出的 arguments 字符数 —— item.done 时对照完整 arguments 补尾。 */
  argsSent?: number;
  /**
   * message / thinking:块未开时缓冲的前导空白 delta。纯空白块与空块一样会被
   * Anthropic 回放 400("text content blocks must contain non-whitespace text"),
   * 所以块只在首个含非空白字符的 delta 到达时打开,此前的空白先缓冲;开块时随首个
   * delta 一并发出(内容不丢),全程纯空白则整块不落地。
   */
  pending?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * 不可打断块(tool_use / thinking)打开期间需要暂存的其它 item 的事件类型。与 text 不同,
 * 这两类块**不可被强制关掉**:
 *   - tool_use:同 id 不能重开,提前关掉会让后续 args delta 无处可去,Claude Code 会
 *     拿着残缺 JSON 去执行工具;
 *   - thinking:signature(encrypted_content,item.done 才到)只能挂在打开的块上,提前
 *     关掉会产出无签名 thinking(translate-request 回放时会丢),reasoning 状态丢失/错位。
 * 因此为别的 item 输出前,若打开的是这两类块,把对方事件排进 deferred 队列,等本块
 * 正常关闭后回放。
 */
const DEFERRABLE_TYPES = new Set([
  'response.output_item.added',
  'response.output_text.delta',
  'response.reasoning_summary_text.delta',
  'response.function_call_arguments.delta',
  'response.output_item.done',
]);

export class SseTranslator {
  private messageStarted = false;
  private finished = false;
  private nextBlockIndex = 0;
  private hasToolUse = false;
  /** output_index → 该 item 的块状态。 */
  private blocks = new Map<number, BlockState>();
  /** 当前打开的 Anthropic 块所属 item 的 output_index;null = 没有块打开(单开块不变量)。 */
  private openOutputIndex: number | null = null;
  private model: string;
  /** 构造时传入非空 model 即 pin —— message_start 固定用它,不被上游回显的裸 model 覆盖。 */
  private readonly modelPinned: boolean;
  /**
   * reasoning blob 的出处命名空间(= bridge provider 前缀,如 'chatgpt/',取 model 首个 '/' 段)。
   * encrypted_content 是各上游私有的不透明状态,跨 provider 回放会被对方 400 拒收;发射时给
   * signature / redacted data 打上前缀,translate-request 侧只回放匹配当前 provider 的 blob。
   */
  private readonly signaturePrefix: string;

  constructor(model: string) {
    this.model = model;
    this.modelPinned = model.length > 0;
    const slash = model.indexOf('/');
    this.signaturePrefix = slash > 0 ? model.slice(0, slash + 1) : '';
  }

  /**
   * deferred 事件队列(见 DEFERRABLE_TYPES 注释):**任一不可打断块**(tool_use / thinking)
   * 打开期间,其它 item 的 DEFERRABLE_TYPES 事件都会入队 —— 不只是 tool_use。
   */
  private deferred: unknown[] = [];

  /** 当前打开的块是否不可打断(tool_use / thinking,见 DEFERRABLE_TYPES 注释)。 */
  private openBlockIsUninterruptible(): boolean {
    if (this.openOutputIndex === null) return false;
    const kind = this.blocks.get(this.openOutputIndex)?.kind;
    return kind === 'function_call' || kind === 'thinking';
  }

  /** 喂一条上游 Responses 事件,返回要写回客户端的 Anthropic 事件(可能 0 条)。 */
  push(ev: unknown): AnthropicSseEvent[] {
    const e = asRecord(ev);
    const type = typeof e.type === 'string' ? e.type : '';
    const out: AnthropicSseEvent[] = [];

    if (this.shouldDefer(e, type)) {
      this.deferred.push(ev);
      return out;
    }
    this.handleEvent(e, type, out);
    // 打开的 tool_use 块正常关闭后,按原序回放暂存的其它 item 事件;若回放中又开了
    // 新 tool_use 块,循环自然停下,余下事件继续等待。
    this.drainDeferred(out, false);
    return out;
  }

  private shouldDefer(e: Record<string, unknown>, type: string): boolean {
    if (!DEFERRABLE_TYPES.has(type)) return false;
    if (!this.openBlockIsUninterruptible()) return false;
    const outputIndex = typeof e.output_index === 'number' ? e.output_index : null;
    // 打开的不可打断块自己的事件(args/summary delta、done)立即处理 —— 解锁队列的钥匙。
    return outputIndex !== this.openOutputIndex;
  }

  private drainDeferred(out: AnthropicSseEvent[], force: boolean): void {
    for (;;) {
      if (this.deferred.length === 0) return;
      // 复用 shouldDefer 逐条判定,取队列中第一条"现在可处理"的事件:
      //   - 无 fc 块打开时即队首(纯 FIFO 回放);
      //   - fc 块打开时是该块自己的事件(args delta / done)—— 解锁钥匙可能被压在
      //     别的 item 事件后面(如 fc1 打开期间队列积了 fc2.added, fc2.args,
      //     msg.added, fc2.done),只看队首会把 fc2.done 搁浅到流结束。
      // 单 item 内部顺序不变;跨 item 的让位仅发生在"被挡"时,且让位对象只会是
      // 当前打开块自己的事件,块序列仍然合规。force(流收尾)= 纯 FIFO 全排空。
      let idx = -1;
      if (force) {
        idx = 0;
      } else {
        for (let i = 0; i < this.deferred.length; i++) {
          const e = asRecord(this.deferred[i]);
          if (!this.shouldDefer(e, typeof e.type === 'string' ? e.type : '')) { idx = i; break; }
        }
        if (idx < 0) return;
      }
      const e = asRecord(this.deferred.splice(idx, 1)[0]);
      this.handleEvent(e, typeof e.type === 'string' ? e.type : '', out);
    }
  }

  private handleEvent(e: Record<string, unknown>, type: string, out: AnthropicSseEvent[]): void {
    // OpenAI 系上游流内错误的惯用形态是 `event: error` + `data: {"error":{...}}` ——
    // data 帧本身没有 type 字段,原先落 default 分支被静默丢弃,CLI 只能拿到空 200 SSE
    // 报 "empty or malformed response" 并盲目重试(#941)。正常 Responses 事件一律带
    // type,无 type 且携带对象 error 字段的帧可无歧义判定为错误帧。
    if (!type && e.error && typeof e.error === 'object') {
      this.onFailed(e, out);
      return;
    }
    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        this.ensureMessageStart(e, out);
        break;
      }
      case 'response.output_item.added': {
        this.onItemAdded(e, out);
        break;
      }
      case 'response.output_text.delta': {
        this.onTextDelta(e, out);
        break;
      }
      case 'response.reasoning_summary_text.delta': {
        this.onReasoningSummaryDelta(e, out);
        break;
      }
      case 'response.function_call_arguments.delta': {
        this.onFunctionArgsDelta(e, out);
        break;
      }
      case 'response.output_item.done': {
        this.onItemDone(e, out);
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        this.onCompleted(e, out);
        break;
      }
      case 'response.failed':
      case 'error': {
        this.onFailed(e, out);
        break;
      }
      default:
        // content_part.added / content_part.done / output_text.done /
        // reasoning_summary_part.added / ping 等对 Anthropic 语义无额外贡献,忽略。
        // (content_part.added 不再用于开 text 块 —— 块惰性开在首个非空 delta 上。)
        break;
    }
  }

  /**
   * 上游读流中途失败(reader 抛错)时的收尾:关块 + `error` 事件,**不发**
   * message_delta/message_stop——已经写出部分内容后再补正常收尾,Claude Code 会把
   * 截断响应当成正常完成,上游读取错误被完全掩盖(review 反馈 P1)。已收尾(错误帧
   * 已翻译 / completed 已处理)则返回空,不重复报错。
   */
  fail(message: string): AnthropicSseEvent[] {
    if (this.finished) return [];
    const out: AnthropicSseEvent[] = [];
    this.emitFailure(message, out);
    return out;
  }

  /** 上游流结束时验证已收到 Responses terminal event;否则按截断失败收尾。 */
  finish(): AnthropicSseEvent[] {
    if (this.finished) return [];
    return this.fail('upstream stream ended before response.completed (stream_truncated)');
  }

  /**
   * 非流式 Responses JSON → 与 SSE 相同的 Anthropic 事件状态机。
   *
   * 先合成标准 Responses 生命周期事件,再复用 push():content block 顺序、reasoning blob、
   * tool arguments、usage 和 stop reason 因而与流式路径保持一致。
   */
  pushJson(raw: unknown): AnthropicSseEvent[] {
    const response = asRecord(raw);
    if (Object.keys(response).length === 0) {
      return this.fail('upstream returned an invalid Responses JSON object');
    }
    if (response.status === 'failed' || response.error) {
      return this.push({ type: 'response.failed', response });
    }
    if (response.status !== 'completed' && response.status !== 'incomplete') {
      return this.fail('upstream returned a non-terminal Responses JSON object');
    }

    const out: AnthropicSseEvent[] = [];
    out.push(...this.push({ type: 'response.created', response }));
    const output = Array.isArray(response.output) ? response.output : [];
    for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
      const item = asRecord(output[outputIndex]);
      const itemType = typeof item.type === 'string' ? item.type : '';
      out.push(...this.push({ type: 'response.output_item.added', output_index: outputIndex, item }));

      if (itemType === 'message') {
        const content = Array.isArray(item.content) ? item.content : [];
        for (const partValue of content) {
          const part = asRecord(partValue);
          if (part.type === 'output_text' && typeof part.text === 'string') {
            out.push(...this.push({
              type: 'response.output_text.delta',
              output_index: outputIndex,
              delta: part.text,
            }));
          }
        }
      } else if (itemType === 'reasoning') {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        for (const partValue of summary) {
          const part = asRecord(partValue);
          if (part.type === 'summary_text' && typeof part.text === 'string') {
            out.push(...this.push({
              type: 'response.reasoning_summary_text.delta',
              output_index: outputIndex,
              delta: part.text,
            }));
          }
        }
      } else if (itemType === 'function_call' && typeof item.arguments === 'string') {
        out.push(...this.push({
          type: 'response.function_call_arguments.delta',
          output_index: outputIndex,
          delta: item.arguments,
        }));
      }

      out.push(...this.push({ type: 'response.output_item.done', output_index: outputIndex, item }));
    }

    const status = response.status === 'incomplete' ? 'response.incomplete' : 'response.completed';
    out.push(...this.push({ type: status, response }));
    return out;
  }

  // ── message_start ──────────────────────────────────────────────────────────
  private ensureMessageStart(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    if (this.messageStarted) return;
    const resp = asRecord(e.response);
    const id = typeof resp.id === 'string' ? resp.id : `msg_${Date.now()}`;
    // message_start.model 固定为构造时传入的 wire model(带 bridge 前缀,如 chatgpt/gpt-5.5);
    // 不被上游回显的裸 model(gpt-5.5)覆盖 —— 下游 token 记账靠前缀区分「订阅轮」与「真网关同名模型」。
    if (!this.modelPinned && typeof resp.model === 'string' && resp.model) this.model = resp.model;
    this.messageStarted = true;
    out.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
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
   * 单开块不变量的执行点:要为 `outputIndex` 的 item 输出前,若当前打开的是**另一个**
   * item 的块,先把它关掉(emit content_block_stop)。被关掉的块后续再有 delta 会走
   * 各 delta handler 的「补开」路径开新块续写。
   */
  private closeOpenBlockForOtherItem(outputIndex: number, out: AnthropicSseEvent[]): void {
    if (this.openOutputIndex === null || this.openOutputIndex === outputIndex) return;
    const st = this.blocks.get(this.openOutputIndex);
    if (st?.opened) {
      out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: st.blockIndex } });
      st.opened = false;
    }
    this.openOutputIndex = null;
  }

  // ── output_item.added ────────────────────────────────────────────────────
  private onItemAdded(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    this.ensureMessageStart(e, out);
    const outputIndex = typeof e.output_index === 'number' ? e.output_index : this.blocks.size;
    // 同一 output_index 重复 added(上游 in_progress→completed 之类的重放):不重置
    // 已有块状态 —— 重置会丢 blockIndex 关联,function_call 还会重发重复 id 的 tool_use。
    if (this.blocks.has(outputIndex)) return;
    const item = asRecord(e.item);
    const itemType = typeof item.type === 'string' ? item.type : '';

    if (itemType === 'reasoning') {
      // 先登记,不开块 —— 有可见 summary 时在首个 summary delta 处开 thinking 块;
      // 无可见 summary 则在 output_item.done 处作为 redacted_thinking 整块吐。
      this.blocks.set(outputIndex, { blockIndex: -1, kind: 'thinking', opened: false });
    } else if (itemType === 'message') {
      // 先登记,不开块 —— 首个非空 output_text.delta 时才开 text 块。曾经在
      // content_part.added 处 eager 开块:纯工具轮的 message item 没有任何文本 delta,
      // 或 text 块刚开就被 function_call 抢占强制关掉,都会落出 `{type:'text',text:''}`
      // 空块进会话历史;切到真 Anthropic 模型回放时 API 400
      // "text content blocks must be non-empty"。
      this.blocks.set(outputIndex, { blockIndex: -1, kind: 'message', opened: false });
    } else if (itemType === 'function_call') {
      this.closeOpenBlockForOtherItem(outputIndex, out);
      const blockIndex = this.nextBlockIndex++;
      this.blocks.set(outputIndex, { blockIndex, kind: 'function_call', opened: true, argsSent: 0 });
      this.openOutputIndex = outputIndex;
      this.hasToolUse = true;
      out.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: typeof item.call_id === 'string' ? item.call_id : String(item.id ?? `call_${blockIndex}`),
            name: typeof item.name === 'string' ? item.name : '',
            input: {},
          },
        },
      });
    }
  }

  // ── output_text.delta ────────────────────────────────────────────────────
  private onTextDelta(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    const outputIndex = typeof e.output_index === 'number' ? e.output_index : -1;
    const st = this.blocks.get(outputIndex);
    const delta = typeof e.delta === 'string' ? e.delta : '';
    if (!st || st.kind !== 'message') return;
    if (!delta) return;
    if (!st.opened) {
      // text 块惰性开在首个含非空白字符的 delta 上;此前的空白 delta 先缓冲
      // (见 BlockState.pending)。空块/纯空白块都不落地,杜绝
      // "text content blocks must be non-empty / contain non-whitespace text" 回放 400。
      const pending = (st.pending ?? '') + delta;
      if (pending.trim().length === 0) {
        st.pending = pending;
        return;
      }
      st.pending = undefined;
      // 开 text 块:首个非空白 delta 到达,或本块曾被别的 item 强制关掉(单开块
      // 不变量)后文本恢复 —— 都开一个新块续写,缓冲的前导空白随首个 delta 发出。
      this.closeOpenBlockForOtherItem(outputIndex, out);
      st.blockIndex = this.nextBlockIndex++;
      st.opened = true;
      this.openOutputIndex = outputIndex;
      out.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index: st.blockIndex, content_block: { type: 'text', text: '' } },
      });
      out.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'text_delta', text: pending } },
      });
      return;
    }
    out.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'text_delta', text: delta } },
    });
  }

  // ── reasoning_summary_text.delta(可见思考文本)──────────────────────────────
  private onReasoningSummaryDelta(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    const outputIndex = typeof e.output_index === 'number' ? e.output_index : -1;
    const st = this.blocks.get(outputIndex);
    const delta = typeof e.delta === 'string' ? e.delta : '';
    if (!st || st.kind !== 'thinking') return;
    if (!st.opened) {
      // 任何 summary delta(含空串/纯空白)都先把本 reasoning item 占为当前打开项:
      // 不可打断语义必须在首个 delta 就生效,其它 item 的事件继续 defer,否则空 delta
      // 会提前放行后续块,encrypted_content 在 item.done 兜底成 redacted_thinking 时
      // 位置错后,translate-request 回放 reasoning 的顺序错位(Responses 回放顺序敏感)。
      // 可见块本身仍惰性开在首个非空白 delta 上(空/纯空白 thinking 块与 text 同理,
      // Anthropic 回放会 400);占位未开块时 openOutputIndex 指向本 item 而
      // st.opened=false,item.done 处负责释放。
      this.closeOpenBlockForOtherItem(outputIndex, out);
      this.openOutputIndex = outputIndex;
      const pending = (st.pending ?? '') + delta;
      if (pending.trim().length === 0) {
        st.pending = pending;
        return;
      }
      st.pending = undefined;
      st.blockIndex = this.nextBlockIndex++;
      st.opened = true;
      out.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index: st.blockIndex, content_block: { type: 'thinking', thinking: '' } },
      });
      out.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'thinking_delta', thinking: pending } },
      });
      return;
    }
    if (!delta) return;
    out.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'thinking_delta', thinking: delta } },
    });
  }

  // ── function_call_arguments.delta ──────────────────────────────────────────
  private onFunctionArgsDelta(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    const outputIndex = typeof e.output_index === 'number' ? e.output_index : -1;
    const st = this.blocks.get(outputIndex);
    const delta = typeof e.delta === 'string' ? e.delta : '';
    // !opened 仅出现在断流强制收尾后(deferred 队列保证 fc 块打开期间不被打断):
    // tool_use 块不能带同 id 重开,迟到的 args 丢弃,item.done 的补尾逻辑兜底。
    if (!st || st.kind !== 'function_call' || !st.opened) return;
    if (delta) {
      st.argsSent = (st.argsSent ?? 0) + delta.length;
      out.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'input_json_delta', partial_json: delta } },
      });
    }
  }

  // ── output_item.done ───────────────────────────────────────────────────────
  private onItemDone(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    const outputIndex = typeof e.output_index === 'number' ? e.output_index : -1;
    const st = this.blocks.get(outputIndex);
    if (!st) return;
    const item = asRecord(e.item);
    const rawEncrypted = typeof item.encrypted_content === 'string' ? item.encrypted_content : '';
    // 打出处前缀(见 signaturePrefix 注释);请求侧按前缀过滤回放。
    // 另把原始 reasoning item id(rs_...)以 `#id=<id>#` 头编进 blob:OpenAI stateless 回放
    // 约定是把完整 output item(含 id)append 回 input,丢 id 时上游可能拒收/忽略回放的
    // reasoning 状态。`#` 不在 base64url 字母表,无歧义;请求侧 splitReasoningBlob 解出。
    const reasoningItemId = st.kind === 'thinking' && typeof item.id === 'string' ? item.id : '';
    const encrypted = rawEncrypted
      ? `${this.signaturePrefix}${reasoningItemId ? `#id=${reasoningItemId}#` : ''}${rawEncrypted}`
      : '';

    if (st.kind === 'thinking') {
      if (st.opened) {
        // 有可见 summary:末尾把 encrypted_content 作为 signature 挂到 thinking 块,再关块。
        if (encrypted) {
          out.push({
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'signature_delta', signature: encrypted } },
          });
        }
        out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: st.blockIndex } });
        st.opened = false;
        if (this.openOutputIndex === outputIndex) this.openOutputIndex = null;
      } else if (encrypted) {
        // 无可见 summary(含全程只发空白 summary delta),或曾在流收尾强制排空时被
        // 关掉(签名没地方挂,仅 stream-end 路径,正常流中 thinking 块不可打断):
        // 作为 redacted_thinking 整块一次性吐(data=encrypted_content),reasoning
        // 状态仍可回放,只丢可见 summary。
        this.closeOpenBlockForOtherItem(outputIndex, out);
        const blockIndex = this.nextBlockIndex++;
        st.blockIndex = blockIndex;
        out.push({
          event: 'content_block_start',
          data: { type: 'content_block_start', index: blockIndex, content_block: { type: 'redacted_thinking', data: encrypted } },
        });
        out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIndex } });
        // 块已即时开+关,标记为已闭合,避免结尾 closeAllOpenBlocks 重复关。
        st.opened = false;
      }
      // 既无 summary 又无 encrypted_content:什么都不吐(空 reasoning)。
      // 释放"占位未开块"的 in-flight 标记(空白 summary delta 只占位不开块,
      // 见 onReasoningSummaryDelta):不释放会让 deferred 队列等不到解锁事件。
      st.pending = undefined;
      if (this.openOutputIndex === outputIndex) this.openOutputIndex = null;
    } else if (st.opened) {
      // function_call:关块前对照 done item 携带的完整 arguments 补发缺失尾段 ——
      // 兜住 args delta 丢失/上游根本不发 delta 只发终值的情况(delta 序列是完整
      // arguments 的前缀,这是 Responses 流式语义)。
      if (st.kind === 'function_call') {
        const fullArgs = typeof item.arguments === 'string' ? item.arguments : '';
        const sent = st.argsSent ?? 0;
        if (fullArgs.length > sent) {
          out.push({
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'input_json_delta', partial_json: fullArgs.slice(sent) } },
          });
          st.argsSent = fullArgs.length;
        }
      }
      // message / function_call:关块。曾被强制关掉的块(opened=false)这里不再补 stop。
      out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: st.blockIndex } });
      st.opened = false;
      if (this.openOutputIndex === outputIndex) this.openOutputIndex = null;
    }
  }

  // ── response.completed / incomplete ────────────────────────────────────────
  private onCompleted(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    if (this.finished) return;
    this.ensureMessageStart(e, out);
    // 流已到尾:暂存队列不会再有解锁事件,强制按原序回放后再收尾。
    this.drainDeferred(out, true);
    this.closeAllOpenBlocks(out);

    const resp = asRecord(e.response);
    const usage = mapUsage(resp.usage);
    const stopReason = this.resolveStopReason(resp);
    out.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        // 上游只在结尾给 usage;input/cache_read 一并放进 message_delta,消费端累计到最终值。
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
  }

  private onFailed(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    if (this.finished) return;
    const resp = asRecord(e.response);
    const err = asRecord(resp.error ?? e.error);
    const baseMessage = typeof err.message === 'string' ? err.message : 'upstream response failed';
    // 上游错误码(code / type,如 context_length_exceeded)一并透传:这是用户判断
    // 「该压缩还是该换模型」的关键信息,也是 CLI 识别可操作错误的原料。
    const code =
      typeof err.code === 'string' && err.code
        ? err.code
        : typeof err.type === 'string' && err.type
          ? err.type
          : '';
    const message = code && !baseMessage.includes(code) ? `[${code}] ${baseMessage}` : baseMessage;
    this.emitFailure(message, out);
  }

  /**
   * 失败收尾的公共实现(流内错误帧与 fail() 共用):已到达的暂存内容先按原序回放、
   * 关掉半开的块,再发一条 Anthropic error 事件(SDK 会把它当 turn 级错误处理)。
   */
  private emitFailure(message: string, out: AnthropicSseEvent[]): void {
    this.drainDeferred(out, true);
    this.closeAllOpenBlocks(out);
    out.push({
      event: 'error',
      data: { type: 'error', error: { type: 'api_error', message } },
    });
    this.finished = true;
  }

  // ── 工具 ────────────────────────────────────────────────────────────────────
  private closeAllOpenBlocks(out: AnthropicSseEvent[]): void {
    for (const st of this.blocks.values()) {
      if (st.opened && st.blockIndex >= 0) {
        out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: st.blockIndex } });
        st.opened = false;
      }
    }
    this.openOutputIndex = null;
  }

  private resolveStopReason(resp: Record<string, unknown>): string {
    const status = typeof resp.status === 'string' ? resp.status : '';
    if (status === 'incomplete') {
      const details = asRecord(resp.incomplete_details);
      if (details.reason === 'max_output_tokens') return 'max_tokens';
    }
    return this.defaultStopReason();
  }

  private defaultStopReason(): string {
    return this.hasToolUse ? 'tool_use' : 'end_turn';
  }
}
