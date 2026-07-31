import { describe, expect, it } from 'vitest';

import { AnthropicSseTranslator, type AnthropicSseEvent } from '../translate-sse.js';

/** 把一段事件流压缩成 (event, key 字段) 列表,便于断言结构。 */
function shape(events: AnthropicSseEvent[]): Array<{ event: string; index?: number; deltaType?: string; text?: string; stopReason?: string | null }> {
  return events.map((ev) => {
    const data = ev.data as Record<string, unknown>;
    if (ev.event === 'content_block_start') {
      const block = data.content_block as Record<string, unknown>;
      return { event: ev.event, index: data.index as number, deltaType: block.type as string };
    }
    if (ev.event === 'content_block_delta') {
      const delta = data.delta as Record<string, unknown>;
      return {
        event: ev.event,
        index: data.index as number,
        deltaType: delta.type as string,
        text: (delta.thinking ?? delta.text ?? delta.partial_json) as string | undefined,
      };
    }
    if (ev.event === 'content_block_stop') {
      return { event: ev.event, index: data.index as number };
    }
    if (ev.event === 'message_delta') {
      const delta = data.delta as Record<string, unknown>;
      return { event: ev.event, stopReason: delta.stop_reason as string | null };
    }
    return { event: ev.event };
  });
}

function run(chunks: unknown[]): AnthropicSseEvent[] {
  const t = new AnthropicSseTranslator('deepseek/deepseek-chat');
  const out: AnthropicSseEvent[] = [];
  for (const c of chunks) out.push(...t.push(c));
  t.markTerminal();
  out.push(...t.finish());
  return out;
}

describe('AnthropicSseTranslator', () => {
  it('emits message_start then streams text blocks and stops with end_turn', () => {
    const events = run([
      { id: 'chatcmpl-1', choices: [{ delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }] },
      { id: 'chatcmpl-1', choices: [{ delta: { content: 'lo' }, finish_reason: null }] },
      { id: 'chatcmpl-1', choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    expect(events[0]).toMatchObject({
      event: 'message_start',
      data: { message: { model: 'deepseek/deepseek-chat', role: 'assistant', id: 'chatcmpl-1' } },
    });
    expect(shape(events.slice(1))).toEqual([
      { event: 'content_block_start', index: 0, deltaType: 'text' },
      { event: 'content_block_delta', index: 0, deltaType: 'text_delta', text: 'Hel' },
      { event: 'content_block_delta', index: 0, deltaType: 'text_delta', text: 'lo' },
      { event: 'content_block_stop', index: 0 },
      { event: 'message_delta', stopReason: 'end_turn' },
      { event: 'message_stop' },
    ]);
  });

  it('streams reasoning_content as thinking blocks before text', () => {
    const events = run([
      { choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    expect(shape(events.slice(1))).toEqual([
      { event: 'content_block_start', index: 0, deltaType: 'thinking' },
      { event: 'content_block_delta', index: 0, deltaType: 'thinking_delta', text: 'think' },
      { event: 'content_block_stop', index: 0 },
      { event: 'content_block_start', index: 1, deltaType: 'text' },
      { event: 'content_block_delta', index: 1, deltaType: 'text_delta', text: 'answer' },
      { event: 'content_block_stop', index: 1 },
      { event: 'message_delta', stopReason: 'end_turn' },
      { event: 'message_stop' },
    ]);
  });

  it('emits tool_use blocks at stream end in index order with full arguments', () => {
    const events = run([
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } },
            ],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 1, id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '' } },
            ],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '{"city":' } },
              { index: 1, function: { arguments: '{"tz":' } },
            ],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"beijing"}' } }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const s = shape(events.slice(1));
    // 两个 tool_use 块按 index 顺序输出,块内带完整 arguments。
    const toolBlocks = s.filter((e) => e.deltaType === 'tool_use');
    expect(toolBlocks).toEqual([
      { event: 'content_block_start', index: 0, deltaType: 'tool_use' },
      { event: 'content_block_start', index: 1, deltaType: 'tool_use' },
    ]);
    const args = s.filter((e) => e.deltaType === 'input_json_delta').map((e) => e.text);
    expect(args).toEqual(['{"city":"beijing"}', '{"tz":']);
    expect(s[s.length - 2]).toEqual({ event: 'message_delta', stopReason: 'tool_use' });
  });

  it('includes usage from the include_usage tail frame in message_delta', () => {
    const events = run([
      { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } },
    ]);
    const messageDelta = events.find((e) => e.event === 'message_delta')!;
    expect(messageDelta.data.usage).toEqual({
      input_tokens: 70,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
    });
  });

  it('maps length finish reason to max_tokens', () => {
    const events = run([
      { choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] },
    ]);
    const messageDelta = events.find((e) => e.event === 'message_delta')!;
    expect((messageDelta.data.delta as Record<string, unknown>).stop_reason).toBe('max_tokens');
  });

  it('does not emit empty/whitespace-only text blocks', () => {
    const events = run([
      { choices: [{ delta: { content: '   ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'x' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const starts = events.filter((e) => e.event === 'content_block_start');
    expect(starts).toHaveLength(1);
    const firstDelta = events.find((e) => e.event === 'content_block_delta')!;
    expect((firstDelta.data.delta as Record<string, unknown>).text).toBe('   x');
  });

  it('interrupts an open thinking block when content arrives (single-open invariant)', () => {
    const events = run([
      { choices: [{ delta: { reasoning_content: 'a' }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_content: 'b', content: 'c' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const s = shape(events.slice(1));
    const stops = s.filter((e) => e.event === 'content_block_stop');
    expect(stops).toHaveLength(2);
    // 同一 chunk 内 reasoning 先于 content 处理:'b' 追加进打开的 thinking 块,
    // content 'c' 到达时打断(关 thinking)再开 text 块 —— 无交错开块。
    expect(s[0]).toEqual({ event: 'content_block_start', index: 0, deltaType: 'thinking' });
    expect(s[1]).toEqual({ event: 'content_block_delta', index: 0, deltaType: 'thinking_delta', text: 'a' });
    expect(s[2]).toEqual({ event: 'content_block_delta', index: 0, deltaType: 'thinking_delta', text: 'b' });
    expect(s[3]).toEqual({ event: 'content_block_stop', index: 0 });
    expect(s[4]).toEqual({ event: 'content_block_start', index: 1, deltaType: 'text' });
    expect(s[5]).toEqual({ event: 'content_block_delta', index: 1, deltaType: 'text_delta', text: 'c' });
  });

  it('fails with an error event and no normal termination on streamed error frames', () => {
    const t = new AnthropicSseTranslator('m');
    const out = t.push({ error: { message: 'upstream exploded' } });
    const evs = [...out, ...t.finish()];
    expect(evs[evs.length - 1]).toMatchObject({
      event: 'error',
      data: { error: { type: 'api_error', message: 'upstream exploded' } },
    });
    expect(evs.some((e) => e.event === 'message_stop')).toBe(false);
  });

  it('fails when the stream ends without any terminal marker', () => {
    const t = new AnthropicSseTranslator('m');
    t.push({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] });
    const evs = t.finish(true);
    expect(evs[evs.length - 1]).toMatchObject({ event: 'error' });
    expect(evs.some((e) => e.event === 'message_stop')).toBe(false);
  });

  it('drops accumulated tool_use on fail', () => {
    const t = new AnthropicSseTranslator('m');
    t.push({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'a', arguments: '{}' } }] },
        finish_reason: null,
      }],
    });
    const evs = t.fail('boom');
    expect(evs.some((e) => e.event === 'content_block_start')).toBe(false);
  });
});
