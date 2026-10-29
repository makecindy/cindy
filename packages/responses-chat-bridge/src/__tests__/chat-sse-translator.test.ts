import { describe, expect, it } from 'vitest';

import { ChatSseTranslator } from '../chat-sse-translator.js';
import { ChatBridgeToolContext } from '../tool-context.js';

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

  it('translates non-streaming message.tool_calls without streaming indexes', () => {
    const translator = new ChatSseTranslator('m');
    const out = [
      ...translator.push({
        id: 'chat_json_tools',
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_json',
              type: 'function',
              function: { name: 'Bash', arguments: '{"cmd":"pwd"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const completed = out.at(-1) as { response: { output: Array<Record<string, unknown>> } };
    expect(completed.response.output).toContainEqual(expect.objectContaining({
      type: 'function_call',
      call_id: 'call_json',
      name: 'Bash',
      arguments: '{"cmd":"pwd"}',
    }));
  });

  it('preserves non-streaming Chat refusal messages as Responses refusal content', () => {
    const translator = new ChatSseTranslator('m');
    const out = [
      ...translator.push({
        id: 'chat_json_refusal',
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            refusal: 'I cannot help with that.',
          },
          finish_reason: 'stop',
        }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    expect(out.map((event) => event.type)).toContain('response.refusal.delta');
    expect(out.map((event) => event.type)).toContain('response.refusal.done');
    const completed = out.at(-1) as { response: { output: Array<Record<string, unknown>> } };
    expect(completed.response.output).toContainEqual(expect.objectContaining({
      type: 'message',
      content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
    }));
  });

  it('waits for a streamed tool name before emitting the call item', () => {
    const translator = new ChatSseTranslator('m');
    const beforeName = translator.push({
      id: 'chatcmpl_args_first',
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_args_first', function: { arguments: '{"x":1}' } }] } }],
    }) as Array<Record<string, unknown>>;
    expect(beforeName.filter((event) => event.type === 'response.output_item.added')).toEqual([]);
    expect(beforeName.filter((event) => event.type === 'response.function_call_arguments.delta')).toEqual([]);

    const out = [
      ...beforeName,
      ...translator.push({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Bash' } }] }, finish_reason: 'tool_calls' }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const added = out.find((event) => event.type === 'response.output_item.added') as { item: { name: string } };
    const deltas = out.filter((event) => event.type === 'response.function_call_arguments.delta') as Array<{ delta: string }>;
    expect(added.item.name).toBe('Bash');
    expect(deltas.map((event) => event.delta).join('')).toBe('{"x":1}');
  });

  it('preserves repeated suffixes split across streamed tool-name fragments', () => {
    const translator = new ChatSseTranslator('m');
    translator.push({
      id: 'chatcmpl_repeated_name',
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_repeated', function: { name: 'foo' } }] } }],
    });
    const out = [
      ...translator.push({
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { name: 'foo', arguments: '{}' } }] },
          finish_reason: 'tool_calls',
        }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const completed = out.at(-1) as { response: { output: Array<Record<string, unknown>> } };
    expect(completed.response.output).toContainEqual(expect.objectContaining({
      type: 'function_call',
      name: 'foofoo',
      arguments: '{}',
    }));
  });

  it('continues accumulating a tool name after its output item has been added', () => {
    const translator = new ChatSseTranslator('m');
    const out = [
      ...translator.push({
        id: 'chatcmpl_name_fragments',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_name_fragments',
              function: { name: 'foo', arguments: '{}' },
            }],
          },
        }],
      }),
      ...translator.push({
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { name: 'bar' } }] },
          finish_reason: 'tool_calls',
        }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;

    const completed = out.at(-1) as { response: { output: Array<Record<string, unknown>> } };
    expect(completed.response.output).toContainEqual(expect.objectContaining({
      type: 'function_call',
      name: 'foobar',
      arguments: '{}',
    }));
  });

  it('force-adds name-only zero-argument tool calls when the stream closes without a finish reason', () => {
    const translator = new ChatSseTranslator('m');
    const beforeFinish = translator.push({
      id: 'chatcmpl_name_only',
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_name_only', function: { name: 'Bash' } }] } }],
    }) as Array<Record<string, unknown>>;
    expect(beforeFinish.some((event) => event.type === 'response.output_item.added')).toBe(false);

    const afterFinish = translator.finish() as Array<Record<string, unknown>>;
    const addedIndex = afterFinish.findIndex((event) => event.type === 'response.output_item.added');
    const doneIndex = afterFinish.findIndex((event) => event.type === 'response.output_item.done');
    expect(addedIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(addedIndex);
    const completed = afterFinish.at(-1) as { response: { output: Array<Record<string, unknown>> } };
    expect(completed.response.output).toContainEqual(expect.objectContaining({
      type: 'function_call',
      call_id: 'call_name_only',
      name: 'Bash',
      arguments: '',
    }));
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

  it('restores custom, namespace, and tool-search calls from Chat function deltas', () => {
    const toolContext = ChatBridgeToolContext.fromRequest({
      model: 'm',
      input: [],
      tools: [
        { type: 'custom', name: 'apply_patch' },
        {
          type: 'namespace',
          name: 'mcp',
          tools: [
            { type: 'function', name: 'query' },
            { type: 'custom', name: 'exec' },
          ],
        },
        { type: 'tool_search' },
      ],
    });
    const translator = new ChatSseTranslator('m', { toolContext });
    const out = [
      ...translator.push({
        id: 'custom',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'c1',
              function: { name: 'apply_patch', arguments: '{"input":"diff"}' },
            }],
          },
        }],
      }),
      ...translator.push({
        choices: [{
          delta: {
            tool_calls: [{
              index: 1,
              id: 'c2',
              function: { name: 'mcp__query', arguments: '{"q":"x"}' },
            }, {
              index: 2,
              id: 'c3',
              function: { name: 'tool_search', arguments: '{"query":"browser"}' },
            }, {
              index: 3,
              id: 'c4',
              function: { name: 'mcp__exec', arguments: '{"input":"code"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const items = out
      .filter((event) => event.type === 'response.output_item.done')
      .map((event) => (event as { item: Record<string, unknown> }).item);
    expect(items.map((item) => item.type)).toEqual([
      'custom_tool_call',
      'function_call',
      'tool_search_call',
      'custom_tool_call',
    ]);
    expect(items[0]).toMatchObject({ call_id: 'c1', name: 'apply_patch', input: 'diff' });
    expect(items[1]).toMatchObject({ call_id: 'c2', name: 'query', namespace: 'mcp' });
    expect(items[2]).toMatchObject({ call_id: 'c3', arguments: { query: 'browser' } });
    expect(items[3]).toMatchObject({
      call_id: 'c4',
      name: 'exec',
      namespace: 'mcp',
      input: 'code',
    });
  });

  it('waits for a catalogued custom tool name before adding its output item', () => {
    const toolContext = ChatBridgeToolContext.fromRequest({
      model: 'm',
      input: [],
      tools: [{ type: 'custom', name: 'apply_patch' }],
    });
    const translator = new ChatSseTranslator('m', { toolContext });

    const first = translator.push({
      id: 'split-custom',
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_split_custom',
            function: { name: 'apply', arguments: '{"input":"diff"}' },
          }],
        },
      }],
    }) as Array<Record<string, unknown>>;
    expect(first.filter((event) => event.type === 'response.output_item.added')).toEqual([]);

    const out = [
      ...first,
      ...translator.push({
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { name: '_patch' } }] },
          finish_reason: 'tool_calls',
        }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const completed = out.at(-1) as { response: { output: Array<Record<string, unknown>> } };
    expect(completed.response.output).toContainEqual(expect.objectContaining({
      type: 'custom_tool_call',
      name: 'apply_patch',
      input: 'diff',
    }));
  });

  it('waits when an exact function name is also a prefix of a longer custom name', () => {
    const toolContext = ChatBridgeToolContext.fromRequest({
      model: 'm',
      input: [],
      tools: [
        { type: 'function', name: 'apply' },
        { type: 'custom', name: 'apply_patch' },
      ],
    });
    const translator = new ChatSseTranslator('m', { toolContext });

    const first = translator.push({
      id: 'ambiguous-tool-name',
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_ambiguous',
            function: { name: 'apply', arguments: '{"input":"diff"}' },
          }],
        },
      }],
    }) as Array<Record<string, unknown>>;
    expect(first.filter((event) => event.type === 'response.output_item.added')).toEqual([]);

    const out = [
      ...first,
      ...translator.push({
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { name: '_patch' } }] },
          finish_reason: 'tool_calls',
        }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const completed = out.at(-1) as { response: { output: Array<Record<string, unknown>> } };
    expect(completed.response.output).toContainEqual(expect.objectContaining({
      type: 'custom_tool_call',
      name: 'apply_patch',
      input: 'diff',
    }));
  });

  it('extracts reasoning_details and inline think blocks without leaking tags', () => {
    const translator = new ChatSseTranslator('m', { inlineReasoning: true });
    const out = [
      ...translator.push({
        id: 'think',
        choices: [{ delta: { reasoning_details: [{ text: 'structured ' }] } }],
      }),
      ...translator.push({
        choices: [{ delta: { content: '<think>inline</think>answer' }, finish_reason: 'stop' }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const response = (out.at(-1) as { response: { output: Array<Record<string, unknown>> } }).response;
    const reasoning = response.output.filter((item) => item.type === 'reasoning');
    const message = response.output.find((item) => item.type === 'message') as {
      content: Array<{ text: string }>;
    };
    expect(reasoning.map((item) => item.summary)).toEqual([
      [{ type: 'summary_text', text: 'structured inline' }],
    ]);
    expect(message.content[0].text).toBe('answer');
  });

  it('preserves literal think tags unless the inline reasoning dialect is enabled', () => {
    const translator = new ChatSseTranslator('m');
    const out = [
      ...translator.push({
        id: 'literal-think',
        choices: [{ delta: { content: '<think>literal</think> answer' }, finish_reason: 'stop' }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const response = (out.at(-1) as { response: { output: Array<Record<string, unknown>> } }).response;
    expect(response.output.filter((item) => item.type === 'reasoning')).toEqual([]);
    expect(response.output.find((item) => item.type === 'message')).toMatchObject({
      content: [{ text: '<think>literal</think> answer' }],
    });
  });

  it('starts streamed tool items with empty arguments and emits the bytes as deltas', () => {
    const translator = new ChatSseTranslator('m');
    const out = [
      ...translator.push({
        id: 'tool-prefix',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_prefix',
              function: { name: 'Bash', arguments: '{"cmd":' },
            }],
          },
        }],
      }),
      ...translator.push({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] }, finish_reason: 'tool_calls' }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const added = out.find((event) => event.type === 'response.output_item.added') as { item: { arguments: string } };
    const deltas = out.filter((event) => event.type === 'response.function_call_arguments.delta') as Array<{ delta: string }>;
    expect(added.item.arguments).toBe('');
    expect(deltas.map((event) => event.delta).join('')).toBe('{"cmd":"pwd"}');
  });

  it('normalizes citations and emits complete zero usage when the provider omits usage', () => {
    const translator = new ChatSseTranslator('m');
    const out = [
      ...translator.push({
        id: 'cite',
        choices: [{
          delta: {
            content: 'answer',
            annotations: [{ type: 'url_citation', url: 'https://example.com', title: 'Source' }],
          },
          finish_reason: 'stop',
        }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    const response = (out.at(-1) as { response: {
      usage: Record<string, unknown>;
      output: Array<{ type: string; content?: Array<{ annotations?: unknown[] }> }>;
    } }).response;
    expect(response.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
    expect(response.output.find((item) => item.type === 'message')?.content?.[0]?.annotations).toEqual([
      {
        type: 'url_citation',
        url: 'https://example.com',
        title: 'Source',
        start_index: 0,
        end_index: 0,
      },
    ]);
  });

  it('maps DeepSeek cache-hit counters into Responses cached tokens', () => {
    const translator = new ChatSseTranslator('deepseek-v4-pro');
    const out = [
      ...translator.push({
        id: 'deepseek-cache',
        choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 120_000,
          prompt_cache_hit_tokens: 118_000,
          prompt_cache_miss_tokens: 2_000,
          completion_tokens: 500,
          total_tokens: 120_500,
        },
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;

    const response = (out.at(-1) as { response: { usage: Record<string, unknown> } }).response;
    expect(response.usage).toEqual({
      input_tokens: 120_000,
      output_tokens: 500,
      total_tokens: 120_500,
      input_tokens_details: { cached_tokens: 118_000 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it('reconstructs DeepSeek total input when only cache hit/miss counters are present', () => {
    const translator = new ChatSseTranslator('deepseek-v4-flash');
    const out = [
      ...translator.push({
        id: 'deepseek-cache-only',
        choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
        usage: {
          prompt_cache_hit_tokens: 80_000,
          prompt_cache_miss_tokens: 1_000,
          completion_tokens: 250,
        },
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;

    const response = (out.at(-1) as { response: { usage: Record<string, unknown> } }).response;
    expect(response.usage).toMatchObject({
      input_tokens: 81_000,
      output_tokens: 250,
      total_tokens: 81_250,
      input_tokens_details: { cached_tokens: 80_000 },
    });
  });

  it('preserves the provider service tier in the terminal Responses object', () => {
    const translator = new ChatSseTranslator('m');
    const out = [
      ...translator.push({
        id: 'service-tier',
        service_tier: 'flex',
        choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
      }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;

    const completed = out.at(-1) as { response: { service_tier?: string } };
    expect(completed.response.service_tier).toBe('flex');
  });
});

// #6531 unit regression: a raw freeform echo must not duplicate a structured call.
const BODY = 'const r = await tools.exec_command({ cmd: "ls" }); text(r.output);';

function customExecContext(): ChatBridgeToolContext {
  return ChatBridgeToolContext.fromRequest({
    model: 'mimo-v2.6-flash',
    input: [],
    tools: [{ type: 'custom', name: 'exec' }],
  });
}

function echo(body = BODY, close = '</function>'): string {
  return `<tool_call><function=exec>${body}${close}</tool_call>`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textOf(events: unknown[]): string {
  return events
    .map(asRecord)
    .filter((event): event is Record<string, unknown> => event?.type === 'response.output_text.delta')
    .map((event) => String(event.delta))
    .join('');
}

function completedItem(
  events: unknown[],
  type: string,
): Record<string, unknown> | undefined {
  return events
    .map(asRecord)
    .filter((event): event is Record<string, unknown> => event?.type === 'response.output_item.done')
    .map((event) => asRecord(event.item))
    .find((item) => item?.type === type);
}

describe('ChatSseTranslator serialized tool-call echo', () => {
  it('fails an under-counted batch without inventing a second structured call', () => {
    const translator = new ChatSseTranslator('m');
    const invoke = '<invoke name="read"><parameter name="path" string="true">a</parameter></invoke>';
    const events = [
      ...translator.push({ choices: [{ delta: { content: '<tool_calls>' + invoke + invoke + '</tool_calls>' } }] }),
      ...translator.push({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'only-call', function: { name: 'read', arguments: '{"path":"a"}' } },
      ] }, finish_reason: 'tool_calls' }] }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;
    expect(events.at(-1)).toMatchObject({ type: 'response.failed' });
    expect(events.filter(e => e.type === 'response.output_item.done' && (e.item as { type: string }).type === 'function_call')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('<tool_calls>');
  });
  // #6545: holding the first text delta cannot give a later tool its output index.
  it('reserves message order before holding a leading tool echo', () => {
    const translator = new ChatSseTranslator('m');
    const markup = '<tool_call>{"name":"read","arguments":{}}</tool_call>';
    const first = translator.push({ choices: [{ delta: { content: markup + 'after' } }] });
    expect(JSON.stringify(first)).not.toContain('<tool_call>');
    const events = [...first, ...translator.push({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'c', function: { name: 'read', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }] }), ...translator.finish()] as Array<Record<string, unknown>>;
    const completed = events.at(-1) as { response: { output: Array<{ type: string; content?: Array<{ text: string }> }> } };
    expect(completed.response.output.map(item => item.type)).toEqual(['message', 'function_call']);
    expect(completed.response.output[0].content?.[0].text).toBe('after');
    expect(events.filter(event => event.type === 'response.output_item.added').map(event => event.output_index)).toEqual([0, 1]);
  });
  it.each(['length', 'content_filter', 'citation'])(
    'keeps original text for %s so truncation and citation offsets stay intact', (reason) => {
      const translator = new ChatSseTranslator('fixture', { toolContext: customExecContext() });
      const events = [
        ...translator.push({ choices: [{ delta: { content: echo(),
          ...(reason === 'citation' ? { annotations: [{ type: 'url_citation',
            url_citation: { url: 'https://example.com', start_index: 2, end_index: 8 } }] } : {}),
        } }] }),
        ...translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1',
          function: { name: 'exec', arguments: JSON.stringify({ input: BODY }) },
        }] }, finish_reason: reason === 'citation' ? 'tool_calls' : reason }] }),
        ...translator.finish(),
      ];
      expect(textOf(events)).toBe(echo());
      expect(completedItem(events, 'custom_tool_call')).toMatchObject({ input: BODY });
    },
  );

  it('drops the echo that duplicates an executed custom call', () => {
    const translator = new ChatSseTranslator('mimo-v2.6-flash', {
      toolContext: customExecContext(),
    });
    const events = [
      ...translator.push({ id: 'c1', choices: [{ delta: { content: 'done.' } }] }),
      ...translator.push({ id: 'c1', choices: [{ delta: { content: echo() } }] }),
      ...translator.push({
        id: 'c1',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'exec', arguments: JSON.stringify({ input: BODY }) },
            }],
          },
        }],
      }),
      ...translator.push({ id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;

    expect(textOf(events)).toBe('done.');
    const custom = completedItem(events, 'custom_tool_call');
    expect(custom).toMatchObject({ name: 'exec', input: BODY });
    expect(events.at(-1)).toMatchObject({ type: 'response.completed' });
  });

  it('drops a prose-adjacent echo on the same line', () => {
    const translator = new ChatSseTranslator('mimo-v2.6-flash', {
      toolContext: customExecContext(),
    });
    const events = [
      ...translator.push({ id: 'c1', choices: [{ delta: { content: `migrated.${echo(BODY, '')}` } }] }),
      ...translator.push({
        id: 'c1',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'exec', arguments: JSON.stringify({ input: BODY }) },
            }],
          },
        }],
      }),
      ...translator.push({ id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;

    expect(textOf(events)).toBe('migrated.');
    expect(completedItem(events, 'custom_tool_call')).toMatchObject({ input: BODY });
  });

  it('keeps the echo when the structured input does not match', () => {
    const translator = new ChatSseTranslator('mimo-v2.6-flash', {
      toolContext: customExecContext(),
    });
    const events = [
      ...translator.push({ id: 'c1', choices: [{ delta: { content: echo() } }] }),
      ...translator.push({
        id: 'c1',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'exec', arguments: JSON.stringify({ input: 'other()' }) },
            }],
          },
        }],
      }),
      ...translator.push({ id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;

    expect(textOf(events)).toBe(echo());
  });

  it('fails a markup-only turn without inventing a tool execution', () => {
    const translator = new ChatSseTranslator('mimo-v2.6-flash', {
      toolContext: customExecContext(),
    });
    const events = [
      ...translator.push({ id: 'c1', choices: [{ delta: { content: echo() } }] }),
      ...translator.push({ id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;

    expect(textOf(events)).toBe('');
    expect(completedItem(events, 'custom_tool_call')).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'response.failed', response: { error: { code: 'unexecuted-tool-markup' } } });
  });

  it('does not match a JSON function call even when the name agrees', () => {
    const translator = new ChatSseTranslator('mimo-v2.6-flash');
    const events = [
      ...translator.push({ id: 'c1', choices: [{ delta: { content: echo() } }] }),
      ...translator.push({
        id: 'c1',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'exec', arguments: '{"cmd":"ls"}' },
            }],
          },
        }],
      }),
      ...translator.push({ id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;

    expect(textOf(events)).toBe(echo());
  });

  it('recognizes the echo when it is split across many deltas', () => {
    const translator = new ChatSseTranslator('mimo-v2.6-flash', {
      toolContext: customExecContext(),
    });
    const events: unknown[] = [];
    const stream = `done.${echo()}`;
    for (let offset = 0; offset < stream.length; offset += 3) {
      events.push(...translator.push({
        id: 'c1',
        choices: [{ delta: { content: stream.slice(offset, offset + 3) } }],
      }));
    }
    events.push(...translator.push({
      id: 'c1',
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            function: { name: 'exec', arguments: JSON.stringify({ input: BODY }) },
          }],
        },
      }],
    }));
    events.push(...translator.push({ id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
    events.push(...translator.finish());

    expect(textOf(events)).toBe('done.');
    expect(completedItem(events, 'custom_tool_call')).toMatchObject({ input: BODY });
  });

  it('releases held text when the turn fails before tools dispatch', () => {
    const translator = new ChatSseTranslator('mimo-v2.6-flash', {
      toolContext: customExecContext(),
    });
    const events = [
      ...translator.push({ id: 'c1', choices: [{ delta: { content: `done.${echo()}` } }] }),
      ...translator.fail('upstream broke'),
    ] as Array<Record<string, unknown>>;

    expect(textOf(events)).toBe(`done.${echo()}`);
    expect(events.at(-1)).toMatchObject({ type: 'response.failed' });
  });

  it('emits prose before the tool call it belongs to', () => {
    const translator = new ChatSseTranslator('mimo-v2.6-flash', {
      toolContext: customExecContext(),
    });
    const events = [
      ...translator.push({ id: 'c1', choices: [{ delta: { content: 'done.' } }] }),
      ...translator.push({ id: 'c1', choices: [{ delta: { content: echo() } }] }),
      ...translator.push({
        id: 'c1',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'exec', arguments: JSON.stringify({ input: BODY }) },
            }],
          },
        }],
      }),
      ...translator.push({ id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ...translator.finish(),
    ] as Array<Record<string, unknown>>;

    const textIndex = events.findIndex((event) => event.type === 'response.output_text.delta');
    const toolIndex = events.findIndex(
      (event) => event.type === 'response.output_item.added'
        && (event.item as Record<string, unknown>).type === 'custom_tool_call',
    );
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(textIndex);
  });
});

// #6531: both native reasoning_content and ordinary content must agree with tool_calls.
describe('cross-grammar reasoning and terminal reconciliation', () => {
  // #6545 review unit: answer citations do not exempt independent reasoning.
  it('preserves cited answer offsets but fails unexecuted reasoning markup', () => {
    const t = new ChatSseTranslator('any-model');
    const events = [
      ...t.push({ choices: [{ delta: { reasoning_content: echo(), content: 'cited answer', annotations: [{ type: 'url_citation',
        url_citation: { url: 'https://example.com', start_index: 0, end_index: 5 } }] }, finish_reason: 'stop' }] }),
      ...t.finish(),
    ];
    expect(events).toContainEqual(expect.objectContaining({ type: 'response.output_text.delta', delta: 'cited answer' }));
    expect(JSON.stringify(events)).not.toContain('<tool_call>');
    expect(events.at(-1)).toMatchObject({ type: 'response.failed' });
  });
  it.each(['content', 'reasoning_content'])(
    'projects DSML in %s, retaining one structured function call', channel => {
      const markup = '<｜DSML｜tool_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">file.txt</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
      const t = new ChatSseTranslator('any-model');
      const events: Array<Record<string, unknown>> = [];
      for (const delta of ['before.', markup.slice(0, 14), markup.slice(14)]) {
        events.push(...t.push({ choices: [{ delta: { [channel]: delta } }] }) as Array<Record<string, unknown>>);
      }
      events.push(...t.push({ choices: [{ delta: { content: channel === 'reasoning_content' ? 'answer' : '', tool_calls: [
        { index: 0, id: 'read1', function: { name: 'read', arguments: '{"path":"file.txt"}' } },
      ] }, finish_reason: 'tool_calls' }] }) as Array<Record<string, unknown>>);
      events.push(...t.finish() as Array<Record<string, unknown>>);
      expect(JSON.stringify(events)).not.toContain('DSML');
      expect(events.at(-1)).toMatchObject({ type: 'response.completed' });
      expect(completedItem(events, 'function_call')).toMatchObject({ name: 'read', arguments: '{"path":"file.txt"}' });
    },
  );
  it('fails a reasoning-only serialized call and preserves ordinary reasoning', () => {
    const t = new ChatSseTranslator('any-model');
    const events = [
      ...t.push({ choices: [{ delta: { reasoning_content: 'think.' + echo() } }] }),
      ...t.push({ choices: [{ delta: { content: 'I finished' }, finish_reason: 'stop' }] }),
      ...t.finish(),
    ];
    expect(JSON.stringify(events)).not.toContain('<tool_call>');
    expect(events.at(-1)).toMatchObject({ type: 'response.failed' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'response.reasoning_summary_text.delta', delta: 'think.' }));
  });
});
