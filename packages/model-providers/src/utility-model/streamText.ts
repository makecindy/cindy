/** Incremental text only; reasoning, tool calls and provider diagnostics are not
 * exposed to a call's transcript. Buffered endpoints keep their existing path. */
export function streamTextDelta(line: string): string {
  if (!line.startsWith('data:')) return '';
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return '';
  try {
    const event = JSON.parse(payload);
    if (
      event.type === 'response.output_text.delta' &&
      typeof event.delta === 'string'
    )
      return event.delta;
    if (
      event.type === 'content_block_delta' &&
      event.delta?.type === 'text_delta' &&
      typeof event.delta.text === 'string'
    )
      return event.delta.text;
    const content = event.choices?.[0]?.delta?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

export function streamTextResult(raw: string): string {
  return raw.split(/\r?\n/).map(streamTextDelta).join('');
}

export async function readUtilityTextStream(
  response: {
    text(): Promise<string>;
    body?: { getReader(): Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'> } | null;
  },
  onText?: (text: string) => void,
): Promise<string> {
  if (!onText || !response.body?.getReader) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let pending = '';
  let text = '';
  let sawEvent = false;
  let terminal = false;
  const consume = (line: string) => {
    if (line.startsWith('data:')) {
      sawEvent = true;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') terminal = true;
      else if (payload) {
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          return;
        }
        if (
          event.type === 'error' ||
          event.type === 'response.failed' ||
          event.type === 'response.incomplete'
        )
          throw new Error('utility_stream_failed');
        if (
          event.type === 'response.completed' ||
          event.type === 'message_stop' ||
          event.choices?.some(
            (choice: { finish_reason?: unknown }) =>
              choice.finish_reason != null,
          )
        )
          terminal = true;
      }
    }
    const delta = streamTextDelta(line);
    if (delta) {
      text += delta;
      onText(text);
    }
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      const value = decoder.decode(chunk.value, { stream: !chunk.done });
      raw += value;
      if (raw.length > 2_000_000) throw new Error('utility_response_too_large');
      pending += value;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        consume(line.replace(/\r$/, ''));
      }
      if (chunk.done) break;
    }
    if (pending) {
      consume(pending);
    }
    if (sawEvent && !terminal) throw new Error('utility_stream_incomplete');
    return raw;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
