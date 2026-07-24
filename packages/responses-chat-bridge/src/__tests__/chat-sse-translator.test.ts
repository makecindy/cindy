import { describe, expect, it } from 'vitest';

import { ChatSseTranslator } from '../chat-sse-translator.js';

describe('ChatSseTranslator', () => {
  it('streams text with a valid Responses lifecycle and keeps usage until finish', () => {
    const translator = new ChatSseTranslator('wire/model');
    const out = [
      ...translator.push({ id: 'chatcmpl_1', model: 'real-model', created: 10, choices: [{ delta: { content: 'hello ' } }] }),
      ...translator.push({ id: 'chatcmpl_1', choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
      ...translator.push({ id: 'chatcmpl_1', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    expect(out.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    const completed = out.at(-1) as { response: { model: string; usage: { total_tokens: number } } };
    expect(completed.response.model).toBe('real-model');
    expect(completed.response.usage.total_tokens).toBe(5);
    // 每个 output_text.delta 必须带 item_id(= 对应 message item 的 id),codex 靠它增量渲染;
    // added 事件的 item.id 与 delta 的 item_id 必须一致。
    const added = out.find((e) => e.type === 'response.output_item.added') as { item: { id: string } };
    const deltas = out.filter((e) => e.type === 'response.output_text.delta') as Array<{ item_id: string }>;
    expect(deltas.length).toBeGreaterThan(0);
    for (const d of deltas) expect(d.item_id).toBe(added.item.id);
  });

  it('keeps usage-only chunks available until stream finish', () => {
    const translator = new ChatSseTranslator('m');
    translator.push({ id: 'chatcmpl_usage', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] });
    translator.push({ id: 'chatcmpl_usage', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
    const out = translator.finish() as Array<Record<string, unknown>>;
    const completed = out.at(-1) as { type: string; response: { usage: { total_tokens: number } } };
    expect(completed.type).toBe('response.completed');
    expect(completed.response.usage.total_tokens).toBe(3);
  });

  it('maps reasoning_content to a reasoning summary item that precedes the message', () => {
    const translator = new ChatSseTranslator('m');
    const out = [
      ...translator.push({ id: 'r1', choices: [{ delta: { reasoning_content: 'think ' } }] }),
      ...translator.push({ id: 'r1', choices: [{ delta: { reasoning_content: 'hard' } }] }),
      ...translator.push({ id: 'r1', choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const types = out.map((e) => e.type);
    // reasoning 事件序列出现,且 reasoning summary 用 summary_index(非 content_index)。
    expect(types).toContain('response.reasoning_summary_part.added');
    expect(types).toContain('response.reasoning_summary_text.delta');
    const rdelta = out.find((e) => e.type === 'response.reasoning_summary_text.delta') as { summary_index: number; item_id: string };
    expect(rdelta.summary_index).toBe(0);
    // reasoning 的 output_item.done 必须在 message 的 output_item.added 之前(reasoning precedes message)。
    const reasoningDoneIdx = out.findIndex((e) => e.type === 'response.output_item.done'
      && (e as { item?: { type?: string } }).item?.type === 'reasoning');
    const messageAddedIdx = out.findIndex((e) => e.type === 'response.output_item.added'
      && (e as { item?: { type?: string } }).item?.type === 'message');
    expect(reasoningDoneIdx).toBeGreaterThanOrEqual(0);
    expect(messageAddedIdx).toBeGreaterThan(reasoningDoneIdx);
    // 终态 output 数组:reasoning 在 message 之前,且 reasoning item 无 status。
    const completed = out.at(-1) as { response: { output: Array<{ type: string; status?: string }> } };
    expect(completed.response.output.map((i) => i.type)).toEqual(['reasoning', 'message']);
    expect(completed.response.output[0].status).toBeUndefined();
  });

  it('keeps interleaved parallel tool argument streams isolated', () => {
    const translator = new ChatSseTranslator('m');
    const out = [
      ...translator.push({
        id: 'chatcmpl_tools',
        choices: [{ delta: { tool_calls: [
          { index: 0, id: 'call_a', function: { name: 'Bash', arguments: '{"a":' } },
          { index: 1, id: 'call_b', function: { name: 'Read', arguments: '{"b":' } },
        ] } }],
      }),
      ...translator.push({
        choices: [{ delta: { tool_calls: [
          { index: 1, function: { arguments: '2}' } },
          { index: 0, function: { arguments: '1}' } },
        ] }, finish_reason: 'tool_calls' }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const done = out.filter((event) => event.type === 'response.output_item.done') as Array<{
      item: { call_id: string; arguments: string };
    }>;
    expect(done.map((event) => [event.item.call_id, event.item.arguments])).toEqual([
      ['call_a', '{"a":1}'],
      ['call_b', '{"b":2}'],
    ]);
    expect(out.at(-1)?.type).toBe('response.completed');
  });

  it('waits for a streamed tool name before emitting the call item', () => {
    const translator = new ChatSseTranslator('m');
    const beforeName = translator.push({
      id: 'chatcmpl_args_first',
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_args_first', function: { arguments: '{"x":' } }] } }],
    }) as Array<Record<string, unknown>>;
    expect(beforeName.filter((event) => event.type === 'response.output_item.added')).toEqual([]);
    expect(beforeName.filter((event) => event.type === 'response.function_call_arguments.delta')).toEqual([]);

    const out = [
      ...beforeName,
      ...translator.push({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Bash', arguments: '1}' } }] }, finish_reason: 'tool_calls' }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const added = out.find((event) => event.type === 'response.output_item.added') as { item: { name: string } };
    const deltas = out.filter((event) => event.type === 'response.function_call_arguments.delta') as Array<{ delta: string }>;
    expect(added.item.name).toBe('Bash');
    expect(deltas.map((event) => event.delta).join('')).toBe('{"x":1}');
  });
  it('creates deterministic ids when the provider omits tool call ids', () => {
    const make = (): unknown[] => {
      const translator = new ChatSseTranslator('m');
      return translator.push({
        id: 'chatcmpl_no_id',
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Bash', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      });
    };
    const id = (events: unknown[]): string => {
      const added = (events as Array<Record<string, unknown>>).find((event) => event.type === 'response.output_item.added') as { item: { call_id: string } };
      return added.item.call_id;
    };
    expect(id(make())).toBe(id(make()));
  });

  it('orders the terminal output array by output index when a tool call precedes text', () => {
    const translator = new ChatSseTranslator('m');
    translator.push({
      id: 'chatcmpl_order',
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_early', function: { name: 'Bash', arguments: '{}' } }] } }],
    });
    const out = [
      ...translator.push({
        choices: [{ delta: { content: 'trailing text' }, finish_reason: 'stop' }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const completed = out.at(-1) as { response: { output: Array<{ type: string }> } };
    // 工具调用先于正文开始 → output 数组必须保持 [function_call, message]（按 outputIndex），
    // 不能无条件把 message 排前面。
    expect(completed.response.output.map((item) => item.type)).toEqual(['function_call', 'message']);
  });

  it('keeps the response id stable when a later chunk introduces an upstream id', () => {
    const translator = new ChatSseTranslator('m');
    const out = [
      ...translator.push({ choices: [{ delta: { content: 'a' } }] }),
      ...translator.push({ id: 'late_chat_id', choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }] }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const created = out.find((event) => event.type === 'response.created') as { response: { id: string } };
    const completed = out.at(-1) as { response: { id: string } };
    const deltas = out.filter((event) => event.type === 'response.output_text.delta') as Array<{ response_id: string }>;
    expect(created.response.id).not.toBe('late_chat_id');
    expect(completed.response.id).toBe(created.response.id);
    expect(deltas.every((event) => event.response_id === created.response.id)).toBe(true);
  });

  it('fails strict finish when the stream lacks a terminal marker', () => {
    const translator = new ChatSseTranslator('m');
    translator.push({ id: 'truncated', choices: [{ delta: { content: 'partial' } }] });
    const out = translator.finish(true) as Array<Record<string, unknown>>;
    expect(out.at(-1)?.type).toBe('response.failed');
    expect(out.filter((event) => event.type === 'response.completed')).toEqual([]);
  });

  it('accepts an explicit DONE marker for strict finish', () => {
    const translator = new ChatSseTranslator('m');
    translator.push({ id: 'done', choices: [{ delta: { content: 'ok' } }] });
    translator.markTerminal();
    expect((translator.finish(true).at(-1) as { type: string }).type).toBe('response.completed');
  });
  it('maps max-length completion to an incomplete terminal response', () => {
    const translator = new ChatSseTranslator('m');
    const out = [
      ...translator.push({ id: 'x', choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    expect(out.at(-1)?.type).toBe('response.incomplete');
    expect((out.at(-1) as { response: { incomplete_details: unknown } }).response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('emits failed once on a stream error', () => {
    const translator = new ChatSseTranslator('m');
    translator.push({ id: 'x', choices: [{ delta: { content: 'partial' } }] });
    const failed = translator.fail('socket reset') as Array<Record<string, unknown>>;
    expect(failed.at(-1)?.type).toBe('response.failed');
    expect(translator.finish()).toEqual([]);
  });

  it('maps a streamed top-level error frame to a failed response (not empty completed)', () => {
    const translator = new ChatSseTranslator('m');
    const out = [
      ...translator.push({ id: 'e1', choices: [{ delta: { content: 'partial' } }] }),
      ...translator.push({ error: { message: 'model overloaded', type: 'server_error' } }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    // 顶层 error 帧 → 终态必须是 failed(带上游 message),不能被 finish() 收成成功空 completed。
    expect(out.at(-1)?.type).toBe('response.failed');
    const failed = out.at(-1) as { response: { error: { message: string } } };
    expect(failed.response.error.message).toBe('model overloaded');
    // fail() 后 translator 已终结,后续 finish() 不再产出。
    expect(out.filter((e) => e.type === 'response.completed')).toEqual([]);
  });
});
