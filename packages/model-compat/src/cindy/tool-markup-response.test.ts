import { expect, it } from 'vitest';
import { ToolMarkupResponseTransform } from './tool-markup-response.js';
import { createCodexResponsesCompatibilityAdapter } from '../codex.js';

// #6531 unit: native Responses bypasses Chat translation. Real Transform input/output
// must keep tool IDs/input and strip serialized text in both streaming/final payloads.
async function transform(events: unknown[], aliases?: ConstructorParameters<typeof ToolMarkupResponseTransform>[0]): Promise<Array<Record<string, unknown>>> {
  const t = new ToolMarkupResponseTransform(aliases);
  let wire = '';
  t.on('data', chunk => { wire += chunk.toString(); });
  const ended = new Promise<void>((resolve, reject) => { t.on('end', resolve); t.on('error', reject); });
  t.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  await ended;
  return wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}
it.each(['response.output_text.delta', 'response.reasoning_summary_text.delta'])(
  'deduplicates native %s and keeps structured custom input', async type => {
    const input = 'text("ok")';
    const markup = '<tool_call><function=exec>' + input + '</tool_call>';
    const events = await transform([
      { type, item_id: 'msg1', content_index: 0, delta: 'before.' + markup.slice(0, 15), sequence_number: 0 },
      { type, item_id: 'msg1', content_index: 0, delta: markup.slice(15), sequence_number: 1 },
      { type: 'response.output_item.done', item: { type: 'custom_tool_call', id: 'ctc1', call_id: 'call1', name: 'exec', input }, sequence_number: 2 },
      { type: 'response.completed', response: { output: [{ type: 'message', id: 'msg1', content: [{ type: 'output_text', text: 'before.' + markup }] }] }, sequence_number: 3 },
    ]);
    expect(JSON.stringify(events)).not.toContain('<tool_call>');
    expect(events).toContainEqual(expect.objectContaining({ type: 'response.output_item.done', item: expect.objectContaining({ id: 'ctc1', call_id: 'call1', input }) }));
    expect(events.filter(e => typeof e.sequence_number === 'number').map(e => e.sequence_number)).toEqual(events.map((_, i) => i));
    expect(events.at(-1)).toMatchObject({ type: 'response.completed' });
  },
);
// #6545 unit: a request-owned alias only supplements an actual matching call.
// Same leaf names, another request, and a wrong tool kind must not validate it.
it.each(['match', 'other-namespace', 'other-request', 'wrong-kind', 'no-call'])(
  'keeps namespace alias evidence scoped to %s', async scenario => {
    const adapter = createCodexResponsesCompatibilityAdapter();
    const request = (namespace: string) => ({ tools: [{ type: 'namespace', name: namespace,
      tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] }] });
    adapter.adaptRequest(request('server'), 1, undefined, true);
    adapter.adaptRequest(request('other'), 2, undefined, true);
    const aliases = adapter.getResponseToolAliases(scenario === 'other-request' ? 2 : 1);
    adapter.releaseResponse(1); adapter.releaseResponse(2);
    expect(adapter.getResponseToolAliases(1)).toBeUndefined();
    expect(adapter.getResponseToolAliases(2)).toBeUndefined();
    const markup = scenario === 'wrong-kind' ? '<tool_call><function=server__read>body</tool_call>'
      : '<tool_call>{"name":"server__read","arguments":{}}</tool_call>';
    const item = { type: 'message', id: 'msg', content: [{ type: 'output_text', text: markup }] };
    const call = scenario === 'wrong-kind'
      ? { type: 'custom_tool_call', id: 'ctc_a', name: 'read', namespace: 'server', call_id: 'a', input: 'body' }
      : { type: 'function_call', id: 'fc_a', name: 'read', namespace: scenario === 'other-namespace' ? 'other' : 'server', call_id: 'a', arguments: '{}' };
    const output = [item, ...(scenario === 'no-call' ? [] : [call])];
    const events = await transform([
      { type: 'response.output_text.delta', item_id: 'msg', content_index: 0, delta: markup },
      { type: 'response.completed', response: { output } },
    ], aliases);
    const removed = scenario === 'match' || scenario === 'no-call';
    expect(events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join('')).toBe(removed ? '' : markup);
    expect(events.at(-1)).toMatchObject({ type: scenario === 'no-call' ? 'response.failed' : 'response.completed' });
    if (scenario !== 'no-call') expect(events.at(-1)).toMatchObject({ response: { output: [expect.anything(), call] } });
  },
);

it('fails final-only native markup instead of showing it or silently succeeding', async () => {
  const item = { type: 'message', id: 'msg', content: [{ type: 'output_text', text: '<invoke name="Read"><parameter name="path" string="true">a</parameter></invoke>' }] };
  const events = await transform([
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { output: [item] } },
  ]);
  expect(JSON.stringify(events)).not.toContain('<invoke');
  expect(events.at(-1)).toMatchObject({ type: 'response.failed', response: { error: { code: 'unexecuted-tool-markup' } } });
});
it('preserves opaque reasoning, tool input and truncated diagnostics', async () => {
  const input = '<tool_call>{"name":"read","arguments":{}}</tool_call>';
  const events = await transform([
    { type: 'response.output_item.done', item: { id: 'r', type: 'reasoning', encrypted_content: input } },
    { type: 'response.output_item.done', item: { id: 'c', call_id: 'c', type: 'custom_tool_call', name: 'exec', input } },
    { type: 'response.incomplete', response: { output: [] } },
  ]);
  expect(events[0]).toMatchObject({ item: { encrypted_content: input } });
  expect(events[1]).toMatchObject({ item: { input } });
  expect(events.at(-1)).toMatchObject({ type: 'response.incomplete' });
});

it('keeps citation offsets and the original upstream error authoritative', async () => {
  const markup = '<tool_call>{"name":"read","arguments":{}}</tool_call>';
  const cited = { type: 'message', id: 'm', content: [{ type: 'output_text', text: markup, annotations: [{ type: 'url_citation', start_index: 0, end_index: 5, url: 'https://example.invalid' }] }] };
  const events = await transform([
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: markup },
    { type: 'response.output_item.done', item: cited },
    { type: 'response.completed', response: { output: [cited] } },
  ]);
  expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: { output: [cited] } });
  expect(events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join('')).toBe(markup);
  const failed = await transform([
    { type: 'response.output_text.delta', delta: markup },
    { type: 'error', code: 'upstream_failure', message: 'original error' },
  ]);
  expect(failed.map(e => e.type)).toEqual(['response.output_text.delta', 'error']);
  expect(failed.at(-1)).toMatchObject({ code: 'upstream_failure', message: 'original error' });
});

// #6545 review unit: citation offsets belong to one content part, not an
// entire response. Exercise streaming, part.done, item.done and final snapshots.
it.each(['reasoning', 'same-item-part', 'other-item'])('isolates citation preservation from %s markup', async location => {
  const markup = '<tool_call>{"name":"read","arguments":{}}</tool_call>';
  const citedPart = { type: 'output_text', text: markup, annotations: [{ type: 'url_citation', start_index: 0, end_index: 5, url: 'https://example.invalid' }] };
  const cited = { type: 'message', id: 'm', content: [citedPart, ...(location === 'same-item-part' ? [{ type: 'output_text', text: markup }] : [])] };
  const reasoning = location === 'reasoning';
  const id = location === 'same-item-part' ? 'm' : 'other';
  const index = location === 'same-item-part' ? 1 : 0;
  const item = reasoning ? { type: 'reasoning', id, summary: [{ type: 'summary_text', text: markup }] }
    : { type: 'message', id, content: [{ type: 'output_text', text: markup }] };
  const suffix = reasoning ? 'reasoning_summary_text' : 'output_text';
  const indices = reasoning ? { summary_index: index } : { content_index: index };
  const output = location === 'same-item-part' ? [cited] : [cited, item];
  const events = await transform([
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: markup },
    { type: 'response.' + suffix + '.delta', item_id: id, ...indices, delta: markup },
    { type: 'response.' + suffix + '.done', item_id: id, ...indices, text: markup },
    { type: reasoning ? 'response.reasoning_summary_part.done' : 'response.content_part.done', item_id: id, ...indices, part: { type: reasoning ? 'summary_text' : 'output_text', text: markup } },
    { type: 'response.output_item.done', item: cited },
    ...(location === 'same-item-part' ? [] : [{ type: 'response.output_item.done', item }]),
    { type: 'response.completed', response: { output } },
  ]);
  expect(events.filter(e => e.type === 'response.output_text.delta' && e.item_id === 'm' && e.content_index === 0).map(e => e.delta).join('')).toBe(markup);
  expect(events.filter(e => e.type === 'response.' + suffix + '.delta' && e.item_id === id && (e.content_index ?? e.summary_index) === index)).toEqual([]);
  expect(events.find(e => e.type === 'response.' + suffix + '.done')).toMatchObject({ text: '' });
  expect(events.at(-1)).toMatchObject({ type: 'response.failed', response: { error: { code: 'unexecuted-tool-markup' }, output: [expect.objectContaining({ content: [citedPart, ...(location === 'same-item-part' ? [{ type: 'output_text', text: '' }] : [])] }), ...(location === 'same-item-part' ? [] : [expect.objectContaining(reasoning ? { summary: [{ type: 'summary_text', text: '' }] } : { content: [{ type: 'output_text', text: '' }] })])] } });
});
