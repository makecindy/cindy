import { describe, expect, it } from 'vitest';
import {
  normalizeRepeatedResponseToolCallIds,
  normalizeRepeatedResponseToolCallIdsFromBody,
  normalizeDeepSeekV41ToolHistory,
} from '../../providers/history';

describe('Responses tool history normalization', () => {
  // #7906: strict Responses providers reject repeated call IDs and duplicate outputs with a 400.
  it('rewrites repeated calls together with their ordered outputs', () => {
    const body = {
      model: 'amazon/nova-pro-v1',
      input: [
        { type: 'function_call', call_id: 'call_retry', name: 'write', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_retry', output: 'failed' },
        { type: 'function_call', call_id: 'call_retry', name: 'write', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_retry', output: 'succeeded' },
      ],
    };

    const normalized = normalizeRepeatedResponseToolCallIds(body);

    expect(normalized?.input).toEqual([
      { type: 'function_call', call_id: 'call_retry', name: 'write', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_retry', output: 'failed' },
      { type: 'function_call', call_id: 'call_retry__cindy_dup_2', name: 'write', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_retry__cindy_dup_2', output: 'succeeded' },
    ]);
    expect(body.input[2]?.call_id).toBe('call_retry');
  });

  it('drops excess results for a single call and leaves valid history untouched', () => {
    const duplicateOutput = {
      input: [
        { type: 'function_call', call_id: 'call_once', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_once', output: 'first' },
        { type: 'function_call_output', call_id: 'call_once', output: 'duplicate' },
      ],
    };
    expect(normalizeRepeatedResponseToolCallIds(duplicateOutput)?.input).toEqual(
      duplicateOutput.input.slice(0, 2),
    );

    const valid = {
      input: [
        { type: 'function_call', call_id: 'call_unique', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_unique', output: 'ok' },
      ],
    };
    expect(normalizeRepeatedResponseToolCallIds(valid)).toBeNull();
  });

  it('avoids colliding with an existing call ID when creating a duplicate suffix', () => {
    const body = {
      input: [
        { type: 'function_call', call_id: 'call_retry', name: 'write', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_retry', output: 'first' },
        { type: 'function_call', call_id: 'call_retry', name: 'write', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_retry', output: 'second' },
        { type: 'function_call', call_id: 'call_retry__cindy_dup_2', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_retry__cindy_dup_2', output: 'independent' },
      ],
    };

    const normalized = normalizeRepeatedResponseToolCallIds(body);

    expect(normalized?.input).toEqual([
      body.input[0], body.input[1],
      { ...body.input[2], call_id: 'call_retry__cindy_dup_3' },
      { ...body.input[3], call_id: 'call_retry__cindy_dup_3' },
      body.input[4], body.input[5],
    ]);
  });

  it('keeps custom tool calls paired with their custom outputs', () => {
    const body = {
      input: [
        { type: 'custom_tool_call', call_id: 'call_custom', name: 'apply_patch', input: 'one' },
        { type: 'custom_tool_call_output', call_id: 'call_custom', output: 'first' },
        { type: 'custom_tool_call', call_id: 'call_custom', name: 'apply_patch', input: 'two' },
        { type: 'custom_tool_call_output', call_id: 'call_custom', output: 'second' },
      ],
    };

    const normalized = normalizeRepeatedResponseToolCallIds(body);

    expect(normalized?.input).toEqual([
      body.input[0], body.input[1],
      { ...body.input[2], call_id: 'call_custom__cindy_dup_2' },
      { ...body.input[3], call_id: 'call_custom__cindy_dup_2' },
    ]);
  });

  it('provides a byte-body repair for the exact 400 recovery path', () => {
    const repaired = normalizeRepeatedResponseToolCallIdsFromBody(Buffer.from(JSON.stringify({
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'run', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'one' },
        { type: 'function_call_output', call_id: 'call_1', output: 'duplicate' },
      ],
    })));

    expect(repaired && JSON.parse(repaired.toString('utf8')).input).toHaveLength(2);
    expect(normalizeRepeatedResponseToolCallIdsFromBody(Buffer.from('{'))).toBeNull();
  });
});

describe('DeepSeek V4.1 interleaved tool results', () => {
  const call = { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' };
  const output = { type: 'function_call_output', call_id: 'call_1', output: 'one' };
  const developer = { type: 'message', role: 'developer', content: 'Keep the result.' };

  // The real XD Responses endpoint rejects an otherwise complete result separated
  // from its call by developer context. Preserve every item and only move results
  // across developer messages within the same complete batch.
  it('preserves reasoning, multiple results and image output while completing the batch', () => {
    const reasoning = { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'synthetic' }] };
    const patch = { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch', input: 'patch' };
    const image = { type: 'custom_tool_call_output', call_id: 'call_2', output: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] };
    const extraDeveloper = { role: 'developer', content: 'Continue.' };
    const user = { type: 'message', role: 'user', content: 'Next turn.' };
    const input = [reasoning, call, patch, image, developer, output, extraDeveloper, user];
    const body = { model: 'deepseek/deepseek-v4.1-flash', input };

    const result = normalizeDeepSeekV41ToolHistory(body);

    expect(result).toEqual({ kind: 'normalized', body: { ...body, input: [reasoning, call, patch, image, output, developer, extraDeveloper, user] } });
    expect(body.input).toEqual([reasoning, call, patch, image, developer, output, extraDeveloper, user]);
    if (result.kind !== 'normalized') throw new Error('expected normalized history');
    expect(normalizeDeepSeekV41ToolHistory(result.body)).toEqual({ kind: 'unchanged' });
  });

  it.each([
    [call, output, developer],
    [developer, call, output],
    [call, { type: 'message', role: 'user', content: 'interruption' }, output],
    [call, { type: 'reasoning', content: [] }, output],
    [call],
  ])('leaves history without an interleaved developer message unchanged', (...input) => {
    expect(normalizeDeepSeekV41ToolHistory({ input })).toEqual({ kind: 'unchanged' });
  });

  it.each([
    [call, developer],
    [call, developer, { ...output, output: undefined, name: 'other' }],
    [call, developer, { type: 'function_call_output', call_id: 'call_1' }],
    [call, developer, { ...output, type: 'custom_tool_call_output' }],
    [call, developer, { ...output, namespace: 'other' }],
    [call, developer, output, { ...output }],
    [call, { ...call }, developer, output],
    [call, developer, { type: 'message', role: 'user', content: 'interruption' }, output],
    [call, developer, { type: 'reasoning', content: [] }, output],
    [call, developer, { ...output, call_id: 'other' }],
  ])('rejects an incomplete or ambiguous developer-interleaved batch', (...input) => {
    expect(normalizeDeepSeekV41ToolHistory({ input })).toEqual({ kind: 'invalid' });
  });
});
