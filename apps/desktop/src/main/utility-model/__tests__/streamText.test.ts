import { describe, expect, it, vi } from 'vitest';
import { readUtilityTextStream, streamTextDelta } from '../streamText.js';

describe('call text streaming', () => {
  it.each([
    ['{"type":"response.output_text.delta","delta":"hello"}', 'hello'],
    ['{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}', 'hello'],
    ['{"choices":[{"delta":{"content":"hello"}}]}', 'hello'],
    ['{"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}', ''],
    ['{"type":"response.function_call_arguments.delta","delta":"do_work"}', ''],
  ])('projects only text from %s', (value, expected) =>
    expect(streamTextDelta(`data: ${value}`)).toBe(expected),
  );
  it('handles chunk boundaries and UTF-8 without losing sentences', async () => {
    const raw = 'data: {"choices":[{"delta":{"content":"你好。"}}]}\r\n\r\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(raw);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const update = vi.fn();
    expect(await readUtilityTextStream({ body, text: async () => '' }, update)).toBe(raw);
    expect(update).toHaveBeenLastCalledWith('你好。');
  });
  it.each([
    ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'utility_stream_incomplete'],
    ['data: {"type":"response.failed"}\n\n', 'utility_stream_failed'],
  ])('does not treat truncated/failed streams as a completed reply', async (raw, error) => {
    const body = new Response(raw).body!;
    await expect(readUtilityTextStream({ body, text: async () => '' }, vi.fn())).rejects.toThrow(
      error,
    );
  });
});
