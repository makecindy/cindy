import { describe, expect, it } from 'vitest';

import { AnthropicSseTranslator } from '../responses-sse-translator.js';
import { encodeThinkingBlock } from '../translate-request.js';

function translator() {
  return new AnthropicSseTranslator('claude', {
    byWireName: new Map([[
      'mcp__read',
      { wireName: 'mcp__read', name: 'read', namespace: 'mcp', kind: 'namespace' },
    ]]),
    byResponseName: new Map(),
  });
}

describe('Anthropic SSE → Responses translation', () => {
  it('emits the Responses lifecycle, text deltas, and sequence-compatible events', () => {
    const t = translator();
    const events = [
      ...t.push({ type: 'message_start', message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 5 } } }),
      ...t.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ...t.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
      ...t.push({ type: 'content_block_stop', index: 0 }),
      ...t.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      ...t.push({ type: 'message_stop' }),
    ];
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'response.created' }),
      expect.objectContaining({ type: 'response.output_text.delta', delta: 'Hello' }),
      expect.objectContaining({ type: 'response.completed' }),
    ]));
    const completed = events.find((event) => (event as { type?: string }).type === 'response.completed') as { response: Record<string, unknown> };
    expect(completed.response.status).toBe('completed');
    expect((completed.response.usage as Record<string, unknown>).input_tokens).toBe(5);
  });

  it('maps tool_use to a namespaced function_call and keeps start-carried input', () => {
    const t = translator();
    const events = [
      ...t.push({ type: 'message_start', message: { id: 'msg_tool', model: 'claude' } }),
      ...t.push({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_1', name: 'mcp__read', input: { path: 'a' } },
      }),
      ...t.push({ type: 'content_block_stop', index: 0 }),
      ...t.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      ...t.push({ type: 'message_stop' }),
    ];
    const done = events.find((event) => (
      (event as { type?: string }).type === 'response.output_item.done'
      && (event as { item?: { type?: string } }).item?.type === 'function_call'
    )) as { item: Record<string, unknown> };
    expect(done.item).toMatchObject({
      type: 'function_call',
      name: 'read',
      namespace: 'mcp',
      arguments: '{"path":"a"}',
    });
  });

  it('restores custom tool input from the compatibility wrapper', () => {
    const t = new AnthropicSseTranslator('claude', {
      byWireName: new Map([[
        'apply_patch',
        { wireName: 'apply_patch', name: 'apply_patch', kind: 'custom' },
      ]]),
      byResponseName: new Map(),
    });
    const events = [
      ...t.push({ type: 'message_start', message: { id: 'msg_custom', model: 'claude' } }),
      ...t.push({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_custom',
          name: 'apply_patch',
        },
      }),
      ...t.push({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"input":"*** Begin Patch"}',
        },
      }),
      ...t.push({ type: 'content_block_stop', index: 0 }),
      ...t.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      ...t.push({ type: 'message_stop' }),
    ];
    const done = events.find((event) => (
      (event as { type?: string }).type === 'response.output_item.done'
      && (event as { item?: { type?: string } }).item?.type === 'custom_tool_call'
    )) as { item: Record<string, unknown> };
    expect(done.item).toMatchObject({
      type: 'custom_tool_call',
      input: '*** Begin Patch',
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'response.custom_tool_call_input.done',
      input: '*** Begin Patch',
    }));
    expect(events.some((event) => (
      (event as { type?: string }).type === 'response.custom_tool_call_input.delta'
    ))).toBe(false);
  });

  it('drops an empty pages argument from the Read tool after streaming completes', () => {
    const t = new AnthropicSseTranslator('claude', {
      byWireName: new Map([[
        'custom_Read',
        { wireName: 'custom_Read', name: 'Read', kind: 'function' },
      ]]),
      byResponseName: new Map(),
    });
    const events = [
      ...t.push({ type: 'message_start', message: { id: 'msg_read', model: 'claude' } }),
      ...t.push({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_read', name: 'custom_Read' },
      }),
      ...t.push({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"file_path":"/tmp/a","pages":""}',
        },
      }),
      ...t.push({ type: 'content_block_stop', index: 0 }),
      ...t.push({ type: 'message_stop' }),
    ];
    expect(events).toContainEqual(expect.objectContaining({
      type: 'response.function_call_arguments.done',
      arguments: '{"file_path":"/tmp/a"}',
    }));
    expect(events.some((event) => (
      (event as { type?: string }).type === 'response.function_call_arguments.delta'
    ))).toBe(false);
  });

  it('carries signed thinking in encrypted_content for the next request', () => {
    const t = translator();
    const events = [
      ...t.push({ type: 'message_start', message: { id: 'msg_reason', model: 'claude' } }),
      ...t.push({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ...t.push({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
      ...t.push({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_123456789' } }),
      ...t.push({ type: 'content_block_stop', index: 0 }),
      ...t.push({ type: 'message_stop' }),
    ];
    const done = events.find((event) => (
      (event as { type?: string }).type === 'response.output_item.done'
      && (event as { item?: { type?: string } }).item?.type === 'reasoning'
    )) as { item: Record<string, unknown> };
    expect(done.item.encrypted_content).toBe(encodeThinkingBlock({
      type: 'thinking',
      thinking: 'hmm',
      signature: 'sig_123456789',
    }));
  });

  it('turns a JSON response into the same SSE lifecycle', () => {
    const events = new AnthropicSseTranslator('claude', {
      byWireName: new Map(),
      byResponseName: new Map(),
    }).pushJson({
      id: 'msg_json',
      type: 'message',
      model: 'claude',
      content: [{ type: 'text', text: 'json' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    expect(events.some((event) => (event as { type?: string }).type === 'response.output_text.delta')).toBe(true);
    expect(events.some((event) => (event as { type?: string }).type === 'response.completed')).toBe(true);
  });

  it('keeps both thinking text and its signature when translating JSON', () => {
    const events = new AnthropicSseTranslator('claude', {
      byWireName: new Map(),
      byResponseName: new Map(),
    }).pushJson({
      id: 'msg_thinking_json',
      type: 'message',
      model: 'claude',
      content: [{
        type: 'thinking',
        thinking: 'hmm',
        signature: 'sig_123456789',
      }],
      stop_reason: 'end_turn',
    });
    const done = events.find((event) => (
      (event as { type?: string }).type === 'response.output_item.done'
      && (event as { item?: { type?: string } }).item?.type === 'reasoning'
    )) as { item: Record<string, unknown> };
    expect(done.item.encrypted_content).toBe(encodeThinkingBlock({
      type: 'thinking',
      thinking: 'hmm',
      signature: 'sig_123456789',
    }));
  });

  it('starts the Responses lifecycle before reporting an upstream error frame', () => {
    const events = new AnthropicSseTranslator('claude', {
      byWireName: new Map(),
      byResponseName: new Map(),
    }).push({ type: 'error', error: { message: 'bad request' } });
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.failed',
    ]);
  });

  it('reports a cleanly truncated stream as incomplete or failed, never completed', () => {
    const t = translator();
    const events = [
      ...t.push({ type: 'message_start', message: { id: 'msg_partial', model: 'claude' } }),
      ...t.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ...t.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
      ...t.finish(),
    ];
    expect(events.some((event) => (event as { type?: string }).type === 'response.incomplete')).toBe(true);
    const terminal = events.find((event) => ['response.completed', 'response.incomplete', 'response.failed'].includes((event as { type?: string }).type ?? '')) as { response: { status: string } };
    expect(terminal.response.status).toBe('incomplete');
    const item = events.find((event) => (
      (event as { type?: string }).type === 'response.output_item.done'
    )) as { item: { status: string } };
    expect(item.item.status).toBe('incomplete');
  });

  it('accepts reasoning_delta as an alias for thinking_delta', () => {
    const t = translator();
    t.push({ type: 'message_start', message: { id: 'msg_reasoning_delta', model: 'claude' } });
    t.push({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
    const events = t.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'reasoning_delta', reasoning: 'working' },
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'response.reasoning_summary_text.delta',
        delta: 'working',
      }),
    ]));
  });

  it('does not mark a truncated tool call as completed', () => {
    const t = translator();
    const events = [
      ...t.push({ type: 'message_start', message: { id: 'msg_partial_tool', model: 'claude' } }),
      ...t.push({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_1', name: 'mcp__read' },
      }),
      ...t.push({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      }),
      ...t.finish(),
    ];
    expect(events.some((event) => (
      (event as { type?: string }).type === 'response.function_call_arguments.done'
    ))).toBe(false);
    expect(events.some((event) => (
      (event as { type?: string; item?: { status?: string } }).item?.status === 'incomplete'
    ))).toBe(true);
  });
});
