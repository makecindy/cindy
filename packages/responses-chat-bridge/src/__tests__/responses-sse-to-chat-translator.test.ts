import { describe, expect, it } from 'vitest';

import { ResponsesSseToChatTranslator } from '../responses-sse-to-chat-translator.js';

function drain(
  translator: ResponsesSseToChatTranslator,
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const chunks: Array<Record<string, unknown>> = [];
  for (const event of events) chunks.push(...translator.push(event));
  chunks.push(...translator.finish());
  return chunks;
}

const TEXT_STREAM: Array<Record<string, unknown>> = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-4o', created_at: 111 } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } },
  { type: 'response.output_text.delta', output_index: 0, delta: 'Hel' },
  { type: 'response.output_text.delta', output_index: 0, delta: 'lo' },
  {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      model: 'gpt-4o',
      created_at: 111,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    },
  },
];

describe('ResponsesSseToChatTranslator (streaming)', () => {
  it('emits role chunk, content deltas, and a final finish chunk', () => {
    const chunks = drain(new ResponsesSseToChatTranslator(), TEXT_STREAM);
    expect(chunks[0]).toMatchObject({
      object: 'chat.completion.chunk',
      id: 'chatcmpl-resp_1',
      model: 'gpt-4o',
      created: 111,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
    expect(chunks[1].choices).toEqual([{ index: 0, delta: { content: 'Hel' }, finish_reason: null }]);
    expect(chunks[2].choices).toEqual([{ index: 0, delta: { content: 'lo' }, finish_reason: null }]);
    const last = chunks[chunks.length - 1];
    expect(last.choices).toEqual([{ index: 0, delta: {}, finish_reason: 'stop' }]);
  });

  it('appends a usage-only chunk when includeUsage is set', () => {
    const chunks = drain(new ResponsesSseToChatTranslator({ includeUsage: true }), TEXT_STREAM);
    const usageChunk = chunks[chunks.length - 1];
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 },
    });
  });

  it('translates the function-call lifecycle into indexed tool_calls deltas', () => {
    const chunks = drain(new ResponsesSseToChatTranslator(), [
      { type: 'response.created', response: { id: 'resp_2', model: 'gpt-4o' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'Bash', arguments: '' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"cmd":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"ls"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{"cmd":"ls"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_a', name: 'Bash', arguments: '{"cmd":"ls"}' } },
      { type: 'response.completed', response: { id: 'resp_2', model: 'gpt-4o' } },
    ]);
    const toolChunks = chunks.filter((c) => {
      const choice = (c.choices as Array<Record<string, unknown>> | undefined)?.[0];
      return choice && (choice.delta as Record<string, unknown>)?.tool_calls;
    });
    expect((toolChunks[0].choices as any)[0].delta.tool_calls).toEqual([{
      index: 0,
      id: 'call_a',
      type: 'function',
      function: { name: 'Bash', arguments: '' },
    }]);
    expect((toolChunks[1].choices as any)[0].delta.tool_calls).toEqual([{
      index: 0,
      function: { arguments: '{"cmd":' },
    }]);
    expect((toolChunks[2].choices as any)[0].delta.tool_calls).toEqual([{
      index: 0,
      function: { arguments: '"ls"}' },
    }]);
    // .done must NOT re-emit args when deltas already streamed them.
    expect(toolChunks).toHaveLength(3);
    const last = chunks[chunks.length - 1];
    expect(last.choices).toEqual([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]);
  });

  it('emits full args on function_call_arguments.done when no deltas were streamed', () => {
    const chunks = drain(new ResponsesSseToChatTranslator(), [
      { type: 'response.created', response: { id: 'resp_3' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_9', call_id: 'call_z', name: 'Grep', arguments: '' },
      },
      { type: 'response.function_call_arguments.done', item_id: 'fc_9', output_index: 0, arguments: '{"q":"x"}' },
      { type: 'response.completed', response: { id: 'resp_3' } },
    ]);
    const argsChunk = chunks.find((c) => {
      const tc = ((c.choices as any)?.[0]?.delta?.tool_calls) as Array<Record<string, unknown>> | undefined;
      return tc && (tc[0].function as Record<string, unknown>)?.arguments === '{"q":"x"}';
    });
    expect(argsChunk).toBeTruthy();
  });

  it('maps response.incomplete (max_output_tokens) to finish_reason length', () => {
    const chunks = drain(new ResponsesSseToChatTranslator(), [
      { type: 'response.created', response: { id: 'resp_4' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'partial' },
      {
        type: 'response.incomplete',
        response: { id: 'resp_4', incomplete_details: { reason: 'max_output_tokens' } },
      },
    ]);
    const last = chunks[chunks.length - 1];
    expect(last.choices).toEqual([{ index: 0, delta: {}, finish_reason: 'length' }]);
  });

  it('produces a Chat error frame on response.failed', () => {
    const t = new ResponsesSseToChatTranslator();
    t.push({ type: 'response.created', response: { id: 'resp_5' } });
    const out = t.push({ type: 'response.failed', response: { error: { message: 'boom' } } });
    expect(out).toEqual([{ error: { message: 'boom', type: 'upstream_error', code: null } }]);
    expect(t.isTerminal).toBe(true);
    // further events are ignored after terminal
    expect(t.push({ type: 'response.output_text.delta', delta: 'x' })).toEqual([]);
  });
});

describe('ResponsesSseToChatTranslator (aggregate / stream:false)', () => {
  it('aggregates text output into a single chat.completion', () => {
    const t = new ResponsesSseToChatTranslator();
    for (const event of TEXT_STREAM) t.push(event);
    const completion = t.aggregate();
    expect(completion).toMatchObject({
      id: 'chatcmpl-resp_1',
      object: 'chat.completion',
      model: 'gpt-4o',
      created: 111,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });
  });

  it('aggregates tool calls into message.tool_calls with null content', () => {
    const t = new ResponsesSseToChatTranslator();
    const events = [
      { type: 'response.created', response: { id: 'resp_6', model: 'gpt-4o' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_a', call_id: 'call_1', name: 'Bash', arguments: '' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_a', output_index: 0, delta: '{"cmd":"ls"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' } },
      { type: 'response.completed', response: { id: 'resp_6' } },
    ];
    for (const event of events) t.push(event);
    const completion = t.aggregate();
    const message = (completion.choices as any)[0].message;
    expect(message.content).toBeNull();
    expect(message.tool_calls).toEqual([{
      id: 'call_1',
      type: 'function',
      function: { name: 'Bash', arguments: '{"cmd":"ls"}' },
    }]);
    expect((completion.choices as any)[0].finish_reason).toBe('tool_calls');
  });
});
