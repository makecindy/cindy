import { describe, expect, it } from 'vitest';
import { createCodexCollaborationMarkerTransform } from '../codex-collaboration-marker.js';

// #9183: the production SSE boundary must mark plaintext before native Codex
// classifies it. Existing null-array/exec tests do not cover this field. Unit
// tier: in-memory streams only; native forwarding is covered by integration.
const response = { contentType: 'text/event-stream; charset=utf-8', contentEncoding: '' };
const item = { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', arguments: '{"message":"正文"}' };
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
async function pump(wire: string, split = wire.length): Promise<string> {
  const transform = createCodexCollaborationMarkerTransform(response)!;
  const chunks: Buffer[] = [];
  const output = (async () => { for await (const chunk of transform) chunks.push(Buffer.from(chunk)); })();
  const bytes = Buffer.from(wire);
  transform.write(bytes.subarray(0, split));
  transform.end(bytes.subarray(split));
  await output;
  return Buffer.concat(chunks).toString();
}

describe('Codex collaboration plaintext marker (#9183)', () => {
  it.each(['collaboration', 'multi_agent_v1', 'multi_agent_v2'])('repairs three tools and terminal snapshots for %s', async namespace => {
    for (const name of ['spawn_agent', 'send_message', 'followup_task']) {
      const call = { ...item, namespace, name };
      const marked = { ...call, encrypted_function_args: [] };
      const events = [
        { type: 'response.output_item.added', item: call },
        { type: 'response.output_item.done', item: call },
        { type: 'response.completed', response: { output: [call] } },
      ];
      expect(await pump(events.map(frame).join(''))).toBe([
        { ...events[0], item: marked }, { ...events[1], item: marked },
        { ...events[2], response: { output: [marked] } },
      ].map(frame).join(''));
    }
  });

  it('preserves explicit encrypted/empty/null/invalid markers and unrelated calls byte for byte', async () => {
    const items = [
      ...[[], ['message'], null, 'unknown'].map(encrypted_function_args => ({ ...item, encrypted_function_args })),
      { ...item, namespace: 'other' }, { ...item, namespace: undefined },
      { ...item, name: 'close_agent' }, { ...item, type: 'custom_tool_call' },
    ];
    const wire = items.map(item => frame({ type: 'response.output_item.done', item })).join('')
      + ': heartbeat\n\ndata: broken json\n\ndata: [DONE]\n\n';
    expect(await pump(wire)).toBe(wire);
  });

  it('preserves metadata, CRLF, multiline data, split UTF-8 and an unterminated final event', async () => {
    const wire = `: keep\r\nid: id1\r\nevent: response.output_item.done\r\ndata: {"type":"response.output_item.done",\r\ndata: "item":${JSON.stringify(item)}}\r\n\r\n`;
    const expected = `: keep\r\nid: id1\r\nevent: response.output_item.done\r\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { ...item, encrypted_function_args: [] } })}\r\ndata:\r\n\r\n`;
    expect(await pump(wire, Buffer.from(wire).indexOf(Buffer.from('正文')) + 1)).toBe(expected);
    expect(await pump(frame({ type: 'response.output_item.done', item }).trimEnd())).toBe(frame({ type: 'response.output_item.done', item: { ...item, encrypted_function_args: [] } }).trimEnd());
  });

  it('leaves compressed and non-SSE responses untouched', () => {
    expect(createCodexCollaborationMarkerTransform({ ...response, contentEncoding: 'gzip' })).toBeNull();
    expect(createCodexCollaborationMarkerTransform({ ...response, contentType: 'application/json' })).toBeNull();
  });
});
