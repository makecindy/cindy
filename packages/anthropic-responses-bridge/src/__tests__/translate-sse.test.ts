import { describe, expect, it } from 'vitest';

import { SseTranslator, type AnthropicSseEvent } from '../translate-sse.js';

/** 把一串上游 Responses 事件喂进 translator,收集全部输出。 */
function run(events: unknown[]): AnthropicSseEvent[] {
  const t = new SseTranslator('gpt-5.5');
  const out: AnthropicSseEvent[] = [];
  for (const e of events) out.push(...t.push(e));
  return out;
}

const types = (evs: AnthropicSseEvent[]) => evs.map((e) => e.event);
const byType = (evs: AnthropicSseEvent[], t: string) => evs.filter((e) => e.event === t);

/**
 * 断言单开块不变量:content block 严格顺序 start→delta→stop,同一时刻至多一个块
 * 打开,块 index 单调递增且 start/stop 严格成对。违反会让 Claude Code 把同一个块
 * flush 两次(实测 UI 正文重复,见 grok 交错流用例)。
 */
function assertSequentialBlocks(evs: AnthropicSseEvent[]): void {
  let open: number | null = null;
  let lastIndex = -1;
  for (const e of evs) {
    const idx = e.data.index as number;
    if (e.event === 'content_block_start') {
      expect(open).toBeNull();
      expect(idx).toBe(lastIndex + 1);
      open = idx;
      lastIndex = idx;
    } else if (e.event === 'content_block_delta') {
      expect(open).toBe(idx);
    } else if (e.event === 'content_block_stop') {
      expect(open).toBe(idx);
      open = null;
    }
  }
  expect(open).toBeNull();
}

describe('SseTranslator', () => {
  it('全序列(reasoning 无 summary + 文本 + 工具调用)映射正确 —— 对齐 Phase0 探针实测流', () => {
    // 探针实测事件序列(带我们读取的字段)。
    const events: unknown[] = [
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
      { type: 'response.in_progress', response: { id: 'resp_1' } },
      // reasoning item:无可见 summary,done 时带 encrypted_content
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'ENC', summary: [] } },
      // message item:output_text 流
      { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.content_part.added', output_index: 1, content_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'hello ' },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'world' },
      { type: 'response.output_text.done', output_index: 1, text: 'hello world' },
      { type: 'response.content_part.done', output_index: 1 },
      { type: 'response.output_item.done', output_index: 1, item: { id: 'msg_1', type: 'message' } },
      // function_call item
      { type: 'response.output_item.added', output_index: 2, item: { id: 'fc_1', type: 'function_call', name: 'get_weather', call_id: 'call_1' } },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"city":' },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"Tokyo"}' },
      { type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"city":"Tokyo"}' },
      { type: 'response.output_item.done', output_index: 2, item: { id: 'fc_1', type: 'function_call', name: 'get_weather', call_id: 'call_1', arguments: '{"city":"Tokyo"}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 22, input_tokens_details: { cached_tokens: 2 }, output_tokens: 6 } } },
    ];
    const out = run(events);

    // message_start 只有一条
    expect(byType(out, 'message_start')).toHaveLength(1);
    expect((out[0].data.message as Record<string, unknown>).model).toBe('gpt-5.5');

    // reasoning 无 summary → 一个 redacted_thinking 块(start+stop);blob = `#id=<item id>#` 头
    // + encrypted_content(id 供请求侧回放时带回原 reasoning item,见 splitReasoningBlob)。
    const starts = byType(out, 'content_block_start');
    const redacted = starts.find((e) => (e.data.content_block as Record<string, unknown>).type === 'redacted_thinking');
    expect(redacted).toBeDefined();
    expect((redacted!.data.content_block as Record<string, unknown>).data).toBe('#id=rs_1#ENC');

    // text 块:两条 text_delta 拼成 hello world
    const textDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'text_delta',
    );
    expect(textDeltas.map((e) => (e.data.delta as Record<string, unknown>).text).join('')).toBe('hello world');

    // tool_use 块:id=call_1,name=get_weather,input_json_delta 拼成完整 JSON
    const toolStart = starts.find((e) => (e.data.content_block as Record<string, unknown>).type === 'tool_use');
    expect(toolStart).toBeDefined();
    expect((toolStart!.data.content_block as Record<string, unknown>).id).toBe('call_1');
    expect((toolStart!.data.content_block as Record<string, unknown>).name).toBe('get_weather');
    const jsonDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'input_json_delta',
    );
    expect(jsonDeltas.map((e) => (e.data.delta as Record<string, unknown>).partial_json).join('')).toBe('{"city":"Tokyo"}');

    // stop_reason=tool_use;usage 换算(input 22-2=20,cache_read=2,output=6)
    const msgDelta = byType(out, 'message_delta');
    expect(msgDelta).toHaveLength(1);
    expect((msgDelta[0].data.delta as Record<string, unknown>).stop_reason).toBe('tool_use');
    expect(msgDelta[0].data.usage).toEqual({
      input_tokens: 20,
      output_tokens: 6,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    });

    // 收尾 message_stop
    expect(byType(out, 'message_stop')).toHaveLength(1);

    // 每个开的块都关了(start 数 == stop 数)
    expect(byType(out, 'content_block_start').length).toBe(byType(out, 'content_block_stop').length);
  });

  it('reasoning 有可见 summary → thinking 块 + 末尾 signature_delta', () => {
    const events: unknown[] = [
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.5' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'think ' },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'hard' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', encrypted_content: 'SIG', summary: [{ type: 'summary_text', text: 'think hard' }] } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 3 } } },
    ];
    const out = run(events);

    const start = byType(out, 'content_block_start')[0];
    expect((start.data.content_block as Record<string, unknown>).type).toBe('thinking');

    const thinkingDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'thinking_delta',
    );
    expect(thinkingDeltas.map((e) => (e.data.delta as Record<string, unknown>).thinking).join('')).toBe('think hard');

    const sig = byType(out, 'content_block_delta').find(
      (e) => (e.data.delta as Record<string, unknown>).type === 'signature_delta',
    );
    expect(sig).toBeDefined();
    expect((sig!.data.delta as Record<string, unknown>).signature).toBe('SIG');

    // end_turn(无工具)
    expect((byType(out, 'message_delta')[0].data.delta as Record<string, unknown>).stop_reason).toBe('end_turn');
  });

  it('带前缀 wire model → signature / redacted data 打出处前缀(供请求侧按 provider 过滤回放)', () => {
    const t = new SseTranslator('chatgpt/gpt-5.5');
    const out: AnthropicSseEvent[] = [];
    for (const ev of [
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.5' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'think' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', encrypted_content: 'SIG' } },
    ]) out.push(...t.push(ev));
    const sig = byType(out, 'content_block_delta').find(
      (e) => (e.data.delta as Record<string, unknown>).type === 'signature_delta',
    );
    expect((sig!.data.delta as Record<string, unknown>).signature).toBe('chatgpt/SIG');
  });

  it('message_start.model 固定为构造时的 wire model(带前缀),不被上游裸 model 覆盖', () => {
    // 用带 bridge 前缀的 wire model 构造;上游 response.created 回显剥了前缀的裸 model。
    const t = new SseTranslator('chatgpt/gpt-5.5');
    const out: AnthropicSseEvent[] = [];
    out.push(...t.push({ type: 'response.created', response: { id: 'r', model: 'gpt-5.5' } }));
    const start = byType(out, 'message_start')[0];
    // 记账靠这个前缀区分订阅轮 vs 真网关同名裸模型 —— 必须保持 chatgpt/gpt-5.5,不被 gpt-5.5 覆盖。
    expect((start.data.message as Record<string, unknown>).model).toBe('chatgpt/gpt-5.5');
  });

  it('response.incomplete(max_output_tokens)→ stop_reason max_tokens', () => {
    const out = run([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.5' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'partial' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    expect((byType(out, 'message_delta')[0].data.delta as Record<string, unknown>).stop_reason).toBe('max_tokens');
  });

  it('response.failed → 关块 + error 事件', () => {
    const out = run([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.5' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'x' },
      { type: 'response.failed', response: { error: { message: 'boom' } } },
    ]);
    expect(types(out)).toContain('error');
    const err = byType(out, 'error')[0];
    expect((err.data.error as Record<string, unknown>).message).toBe('boom');
    // 半开的 text 块被关掉
    expect(byType(out, 'content_block_stop').length).toBeGreaterThanOrEqual(1);
  });

  it('OpenAI 风格流内错误帧(data 无 type,只有 error 对象)→ error 事件并透传 code(#941)', () => {
    // `event: error` + `data: {"error":{...}}` 是 OpenAI 系上游的惯用错误形态,
    // data 帧没有 type 字段;修复前落 default 分支被静默丢弃,整流零事件、CLI 只能
    // 报 "empty or malformed response (HTTP 200)" 并盲目重试。
    const out = run([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.5' } },
      { error: { message: 'context window exceeded', code: 'context_length_exceeded' } },
    ]);
    expect(types(out)).toContain('error');
    const err = byType(out, 'error')[0];
    expect((err.data.error as Record<string, unknown>).message).toBe(
      '[context_length_exceeded] context window exceeded',
    );
  });

  it('错误帧 code 缺失时用 type 字段;两者都无则只透传 message', () => {
    const withType = run([{ error: { message: 'boom', type: 'server_error' } }]);
    expect((byType(withType, 'error')[0].data.error as Record<string, unknown>).message).toBe(
      '[server_error] boom',
    );
    const bare = run([{ error: { message: 'boom' } }]);
    expect((byType(bare, 'error')[0].data.error as Record<string, unknown>).message).toBe('boom');
  });

  it('grok 交错流:message item 挂着不关、中间穿插 function_call → 强制关块保持单开块不变量,text 不重复', () => {
    // 2026-07-08 实测 xai/grok-4.5:message(text) item 发完 delta 后不发 output_item.done,
    // 先穿插若干 function_call item,message 的 done 最后才到。修复前 text 块跨越多个
    // tool_use 块保持打开,Claude Code 会把同一 text 块 flush 成两条 assistant 消息(UI 正文双份)。
    const events: unknown[] = [
      { type: 'response.created', response: { id: 'r', model: 'grok-4.5' } },
      // reasoning:正常开关
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'plan' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'ENC' } },
      // message:text 全部流完但不发 done
      { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.content_part.added', output_index: 1, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 1, delta: '我来跑几条命令。' },
      // 两个 function_call 穿插进来(此刻 text 块必须先被关掉)
      { type: 'response.output_item.added', output_index: 2, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"a":1}' },
      { type: 'response.output_item.done', output_index: 2, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.output_item.added', output_index: 3, item: { id: 'fc_2', type: 'function_call', name: 'Bash', call_id: 'call_2' } },
      { type: 'response.output_item.done', output_index: 3, item: { id: 'fc_2', type: 'function_call', name: 'Bash', call_id: 'call_2' } },
      // message 的 done 迟到:块已被强制关掉,不能再补第二个 stop
      { type: 'response.output_item.done', output_index: 1, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.output_item.added', output_index: 4, item: { id: 'fc_3', type: 'function_call', name: 'Bash', call_id: 'call_3' } },
      { type: 'response.output_item.done', output_index: 4, item: { id: 'fc_3', type: 'function_call', name: 'Bash', call_id: 'call_3' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const out = run(events);

    // 硬约定:块严格顺序开关,任何时刻至多一个块打开
    assertSequentialBlocks(out);

    // text 只出现一个块、内容只发一次
    const starts = byType(out, 'content_block_start');
    const textStarts = starts.filter((e) => (e.data.content_block as Record<string, unknown>).type === 'text');
    expect(textStarts).toHaveLength(1);
    const textDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'text_delta',
    );
    expect(textDeltas.map((e) => (e.data.delta as Record<string, unknown>).text).join('')).toBe('我来跑几条命令。');

    // 3 个 tool_use 各一块,id 不重复
    const toolStarts = starts.filter((e) => (e.data.content_block as Record<string, unknown>).type === 'tool_use');
    expect(toolStarts.map((e) => (e.data.content_block as Record<string, unknown>).id)).toEqual(['call_1', 'call_2', 'call_3']);
  });

  it('grok 交错流:text 被强制关掉后又续写 → 开新 text 块续内容(不丢、不重复)', () => {
    const events: unknown[] = [
      { type: 'response.created', response: { id: 'r', model: 'grok-4.5' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.content_part.added', output_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '前半段;' },
      { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '后半段。' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const out = run(events);

    assertSequentialBlocks(out);

    // 拆成两个 text 块,内容合起来完整
    const starts = byType(out, 'content_block_start');
    const textStarts = starts.filter((e) => (e.data.content_block as Record<string, unknown>).type === 'text');
    expect(textStarts).toHaveLength(2);
    const textDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'text_delta',
    );
    expect(textDeltas.map((e) => (e.data.delta as Record<string, unknown>).text).join('')).toBe('前半段;后半段。');
  });

  it('同一 output_index 重复 output_item.added 不重置块状态、不重发 tool_use start', () => {
    const events: unknown[] = [
      { type: 'response.created', response: { id: 'r', model: 'grok-4.5' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":1}' },
      // 上游重放 added(如 in_progress → completed)
      { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const out = run(events);

    assertSequentialBlocks(out);
    expect(byType(out, 'content_block_start')).toHaveLength(1);
    expect(byType(out, 'content_block_stop')).toHaveLength(1);
  });

  it('tool_use 块流参数期间被别的 item 交错 → 其它事件暂存,args 完整不丢(review P2 场景)', () => {
    // parallel_tool_calls=true 下理论可发生:text 事件插进正在流式传输的 fc args 中间。
    // fc 块不可拆,对方事件必须暂存到 fc 正常关闭后按原序回放。
    const events: unknown[] = [
      { type: 'response.created', response: { id: 'r', model: 'grok-4.5' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"cmd":' },
      // message 事件插进来:必须暂存,不能打断 fc 块
      { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.content_part.added', output_index: 1, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 1, delta: '跑个命令。' },
      // fc 参数尾段与收尾
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"ls"}' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1', arguments: '{"cmd":"ls"}' } },
      { type: 'response.output_item.done', output_index: 1, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const out = run(events);

    assertSequentialBlocks(out);
    // args 完整:两段 delta 全部落进 tool_use 块
    const jsonDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'input_json_delta',
    );
    expect(jsonDeltas.map((e) => (e.data.delta as Record<string, unknown>).partial_json).join('')).toBe('{"cmd":"ls"}');
    // 暂存的 text 在 fc 关闭后原序回放
    const textDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'text_delta',
    );
    expect(textDeltas.map((e) => (e.data.delta as Record<string, unknown>).text).join('')).toBe('跑个命令。');
    // 顺序:tool_use 块先关,text 块后开
    const starts = byType(out, 'content_block_start');
    expect((starts[0].data.content_block as Record<string, unknown>).type).toBe('tool_use');
    expect((starts[1].data.content_block as Record<string, unknown>).type).toBe('text');
  });

  it('两个 tool_use 参数流交错 → 后者暂存,双方 args 都完整', () => {
    const events: unknown[] = [
      { type: 'response.created', response: { id: 'r', model: 'grok-4.5' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":' },
      // fc_2 在 fc_1 未关时到达:整体暂存
      { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_2', type: 'function_call', name: 'Bash', call_id: 'call_2' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"b":2}' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1', arguments: '{"a":1}' } },
      // fc_2 的 done 故意不带 arguments:参数必须由队内暂存的 delta 回放供给,
      // 不能依赖 done 补尾兜底(review 第二轮 P2:drain 开出新 fc 块后要继续回放它自己的 args)。
      { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_2', type: 'function_call', name: 'Bash', call_id: 'call_2' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const out = run(events);

    assertSequentialBlocks(out);
    const starts = byType(out, 'content_block_start');
    expect(starts.map((e) => (e.data.content_block as Record<string, unknown>).id)).toEqual(['call_1', 'call_2']);
    // 按块 index 归集 args,双方都完整
    const argsByIndex = new Map<number, string>();
    for (const e of byType(out, 'content_block_delta')) {
      const d = e.data.delta as Record<string, unknown>;
      if (d.type !== 'input_json_delta') continue;
      const idx = e.data.index as number;
      argsByIndex.set(idx, (argsByIndex.get(idx) ?? '') + String(d.partial_json));
    }
    expect([...argsByIndex.values()]).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('队列中 fc2.done 被压在 msg.added 后面 → 不搁浅,fc2 正常收尾后再回放 msg(review 第三轮 P2 场景)', () => {
    // fc1 打开期间队列积成 [fc2.added, fc2.args, msg.added, fc2.done]:drain 只看队首会
    // 停在 msg.added(fc2 打开被挡),把 fc2.done 搁浅到流结束。应让 fc2 自己的事件先行。
    const events: unknown[] = [
      { type: 'response.created', response: { id: 'r', model: 'grok-4.5' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":1}' },
      // 以下四条在 fc1 打开期间到达,全部入队
      { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_2', type: 'function_call', name: 'Bash', call_id: 'call_2' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"b":' },
      { type: 'response.output_item.added', output_index: 2, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_2', type: 'function_call', name: 'Bash', call_id: 'call_2', arguments: '{"b":2}' } },
      // fc1 收尾 → 触发 drain
      { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1', arguments: '{"a":1}' } },
      // msg 的正文与收尾在 drain 后到达
      { type: 'response.output_text.delta', output_index: 2, delta: '好了。' },
      { type: 'response.output_item.done', output_index: 2, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const out = run(events);

    assertSequentialBlocks(out);
    // fc2 在流中段就完整收尾(done 未被搁浅):args = 队内 delta + done 补尾
    const argsByIndex = new Map<number, string>();
    for (const e of byType(out, 'content_block_delta')) {
      const d = e.data.delta as Record<string, unknown>;
      if (d.type !== 'input_json_delta') continue;
      argsByIndex.set(e.data.index as number, (argsByIndex.get(e.data.index as number) ?? '') + String(d.partial_json));
    }
    expect([...argsByIndex.values()]).toEqual(['{"a":1}', '{"b":2}']);
    // 块顺序:tool_use(fc1) → tool_use(fc2) → text,且 text 在 fc2 stop 之后才开
    const starts = byType(out, 'content_block_start');
    expect(starts.map((e) => (e.data.content_block as Record<string, unknown>).type)).toEqual(['tool_use', 'tool_use', 'text']);
    const textDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'text_delta',
    );
    expect(textDeltas.map((e) => (e.data.delta as Record<string, unknown>).text).join('')).toBe('好了。');
  });

  it('可见 thinking 打开期间被其它 item 交错 → 暂存不强关,signature 完整挂上(review 第四轮 P2 场景)', () => {
    // thinking 的 signature 在 item.done 才到、只能挂在打开的块上:若被强关,可见 thinking
    // 变无签名块(回放即丢)+ redacted 兜底还会把 reasoning 状态挪到中间内容之后。
    const t = new SseTranslator('xai/grok-4.5');
    const out: AnthropicSseEvent[] = [];
    for (const ev of [
      { type: 'response.created', response: { id: 'r', model: 'grok-4.5' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'thinking...' },
      // reasoning 未 done,message 和 fc 事件插进来:必须暂存
      { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.output_text.delta', output_index: 1, delta: '正文。' },
      { type: 'response.output_item.added', output_index: 2, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      // reasoning 收尾:signature 挂到打开的 thinking 块,随后按序回放暂存事件
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'ENC', summary: [{ type: 'summary_text', text: 'thinking...' }] } },
      { type: 'response.output_item.done', output_index: 2, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1', arguments: '{}' } },
      { type: 'response.output_item.done', output_index: 1, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]) out.push(...t.push(ev));

    assertSequentialBlocks(out);
    // thinking 块:signature_delta 在其 stop 之前发出,且不产生 redacted_thinking
    const starts = byType(out, 'content_block_start');
    expect(starts.map((e) => (e.data.content_block as Record<string, unknown>).type)).toEqual(['thinking', 'text', 'tool_use']);
    const sig = byType(out, 'content_block_delta').find(
      (e) => (e.data.delta as Record<string, unknown>).type === 'signature_delta',
    );
    expect(sig).toBeDefined();
    expect((sig!.data.delta as Record<string, unknown>).signature).toBe('xai/#id=rs_1#ENC');
    // 暂存的正文在 thinking 收尾后完整回放
    const textDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'text_delta',
    );
    expect(textDeltas.map((e) => (e.data.delta as Record<string, unknown>).text).join('')).toBe('正文。');
  });

  it('上游只发 arguments 终值不发 delta → item.done 时补发完整 args', () => {
    const out = run([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.5' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1', arguments: '{"x":9}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    assertSequentialBlocks(out);
    const jsonDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'input_json_delta',
    );
    expect(jsonDeltas.map((e) => (e.data.delta as Record<string, unknown>).partial_json).join('')).toBe('{"x":9}');
  });

  it('断流 finish() 时暂存事件强制回放,不静默丢内容', () => {
    const t = new SseTranslator('grok-4.5');
    const out: AnthropicSseEvent[] = [];
    out.push(...t.push({ type: 'response.created', response: { id: 'r', model: 'grok-4.5' } }));
    out.push(...t.push({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } }));
    // fc 未关时 text 到达 → 暂存;随后上游断流
    out.push(...t.push({ type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message' } }));
    out.push(...t.push({ type: 'response.output_text.delta', output_index: 1, delta: '半截话' }));
    out.push(...t.finish());
    const textDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'text_delta',
    );
    expect(textDeltas.map((e) => (e.data.delta as Record<string, unknown>).text).join('')).toBe('半截话');
    expect(types(out)).toContain('error');
    expect(types(out)).not.toContain('message_stop');
  });

  it('既有顺序流(codex 风格)行为不变:块序与内容与修复前一致', () => {
    // 与首个用例同构的顺序流,重点断言单开块不变量在正常流下也成立(回归保护)。
    const out = run([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.5' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'think' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', encrypted_content: 'SIG' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message' } },
      { type: 'response.content_part.added', output_index: 1, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 1, delta: 'hi' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'message' } },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{}' },
      { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    assertSequentialBlocks(out);
    expect(byType(out, 'content_block_start')).toHaveLength(3);
    expect(byType(out, 'content_block_stop')).toHaveLength(3);
  });

  it('message item 无任何文本 delta(纯工具轮)→ 不产出空 text 块', () => {
    // 2026-07-23 实测 chatgpt/gpt-5.6-sol:每个带工具调用的轮次都会先发 message item
    // (content_part.added)再发 function_call。修复前 content_part.added 处 eager 开的
    // text 块被 function_call 强制关掉,落成 `{type:'text',text:''}` 空块进会话历史;
    // 会话切到真 Anthropic 模型回放时 API 400 "text content blocks must be non-empty"。
    const events: unknown[] = [
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.6-sol' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.content_part.added', output_index: 0, part: { type: 'output_text', text: '' } },
      // 没有任何 output_text.delta,直接进工具调用
      { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' },
      { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1', arguments: '{}' } },
      { type: 'response.content_part.done', output_index: 0 },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const out = run(events);

    assertSequentialBlocks(out);
    const starts = byType(out, 'content_block_start');
    // 只有 tool_use 块,没有 text 块
    expect(starts.map((e) => (e.data.content_block as Record<string, unknown>).type)).toEqual(['tool_use']);
  });

  it('content_part.added 后才来非空 delta → text 块开在首个非空 delta 上,内容完整', () => {
    const out = run([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.6-sol' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.content_part.added', output_index: 0, part: { type: 'output_text', text: '' } },
      // 上游可能先发空 delta:同样不开块
      { type: 'response.output_text.delta', output_index: 0, delta: '' },
      { type: 'response.output_text.delta', output_index: 0, delta: '正文' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    assertSequentialBlocks(out);
    const starts = byType(out, 'content_block_start');
    expect(starts.map((e) => (e.data.content_block as Record<string, unknown>).type)).toEqual(['text']);
    const textDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'text_delta',
    );
    expect(textDeltas.map((e) => (e.data.delta as Record<string, unknown>).text).join('')).toBe('正文');
  });

  it('纯空白 text delta(工具轮前的换行)→ 不开 text 块,不产出纯空白块(review P1)', () => {
    // 空白-only 块与空块同罪:Anthropic 回放 400 "text content blocks must contain
    // non-whitespace text"。前导空白必须缓冲到首个非空白 delta 才随块发出。
    const out = run([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.6-sol' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.content_part.added', output_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '\n' },
      { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' },
      { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1', arguments: '{}' } },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    assertSequentialBlocks(out);
    const starts = byType(out, 'content_block_start');
    expect(starts.map((e) => (e.data.content_block as Record<string, unknown>).type)).toEqual(['tool_use']);
  });

  it('前导空白 delta 后跟正文 → 单个 text 块,空白随首个非空白 delta 一并发出(内容不丢)', () => {
    const out = run([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.6-sol' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '\n\n' },
      { type: 'response.output_text.delta', output_index: 0, delta: '正文' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    assertSequentialBlocks(out);
    const starts = byType(out, 'content_block_start');
    expect(starts.map((e) => (e.data.content_block as Record<string, unknown>).type)).toEqual(['text']);
    const textDeltas = byType(out, 'content_block_delta').filter(
      (e) => (e.data.delta as Record<string, unknown>).type === 'text_delta',
    );
    expect(textDeltas.map((e) => (e.data.delta as Record<string, unknown>).text).join('')).toBe('\n\n正文');
  });

  it('reasoning 只发空 summary delta 且被其它 item 交错 → 仍占位 defer,redacted_thinking 顺序不错位(review P1)', () => {
    // 空 delta 不能让 reasoning 失去不可打断地位:否则后续块先行发出,encrypted_content
    // 在 done 兜底成 redacted_thinking 时排到后面,translate-request 回放 reasoning 顺序错位。
    const out = run([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.6-sol' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '' },
      // reasoning 未 done,fc 事件插进来:必须 defer
      { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'ENC', summary: [] } },
      { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', name: 'Bash', call_id: 'call_1', arguments: '{}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    assertSequentialBlocks(out);
    const starts = byType(out, 'content_block_start');
    // redacted_thinking 在 tool_use 之前(占位 defer 生效,顺序保持)
    expect(starts.map((e) => (e.data.content_block as Record<string, unknown>).type)).toEqual(['redacted_thinking', 'tool_use']);
    expect((starts[0].data.content_block as Record<string, unknown>).data).toBe('#id=rs_1#ENC');
  });

  it('reasoning 只发纯空白 summary delta → 不开 thinking 块,encrypted_content 走 redacted_thinking', () => {
    const out = run([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.6-sol' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '\n ' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'ENC', summary: [] } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    assertSequentialBlocks(out);
    const starts = byType(out, 'content_block_start');
    expect(starts.map((e) => (e.data.content_block as Record<string, unknown>).type)).toEqual(['redacted_thinking']);
  });

  it('reasoning item 只发空 summary delta → 不开 thinking 块,encrypted_content 走 redacted_thinking', () => {
    const out = run([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.6-sol' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'ENC', summary: [] } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    assertSequentialBlocks(out);
    const starts = byType(out, 'content_block_start');
    // 没有空 thinking 块;加密推理以 redacted_thinking 保留
    expect(starts.map((e) => (e.data.content_block as Record<string, unknown>).type)).toEqual(['redacted_thinking']);
    expect((starts[0].data.content_block as Record<string, unknown>).data).toBe('#id=rs_1#ENC');
  });

  it('clean EOF before response.completed → error without message_stop', () => {
    const t = new SseTranslator('gpt-5.5');
    const out: AnthropicSseEvent[] = [];
    out.push(...t.push({ type: 'response.created', response: { id: 'r', model: 'gpt-5.5' } }));
    out.push(...t.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }));
    out.push(...t.push({ type: 'response.output_text.delta', output_index: 0, delta: 'x' }));
    out.push(...t.finish());
    expect(types(out)).toContain('error');
    expect(types(out)).not.toContain('message_delta');
    expect(types(out)).not.toContain('message_stop');
    expect((byType(out, 'error')[0].data.error as Record<string, unknown>).message).toContain('stream_truncated');
    // finish 幂等
    expect(t.finish()).toHaveLength(0);
  });

  it('非流式 Responses JSON 复用状态机翻译 text / tool / usage', () => {
    const t = new SseTranslator('chatgpt/gpt-5.6-sol');
    const out = t.pushJson({
      id: 'resp_1',
      model: 'gpt-5.6-sol',
      status: 'completed',
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello' }],
        },
        {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'Bash',
          arguments: '{"command":"pwd"}',
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    expect(types(out)).toContain('message_start');
    expect(types(out)).toContain('message_stop');
    expect((byType(out, 'message_delta')[0].data.delta as Record<string, unknown>).stop_reason).toBe('tool_use');
    const text = byType(out, 'content_block_delta')
      .filter((event) => (event.data.delta as Record<string, unknown>).type === 'text_delta')
      .map((event) => (event.data.delta as Record<string, unknown>).text)
      .join('');
    expect(text).toBe('hello');
    const toolInput = byType(out, 'content_block_delta')
      .filter((event) => (event.data.delta as Record<string, unknown>).type === 'input_json_delta')
      .map((event) => (event.data.delta as Record<string, unknown>).partial_json)
      .join('');
    expect(toolInput).toBe('{"command":"pwd"}');
  });
});
