import { describe, expect, it } from 'vitest';
import {
  normalizeRepeatedResponseToolCallIds,
  normalizeRepeatedResponseToolCallIdsFromBody,
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
