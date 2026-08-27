import { describe, expect, it } from 'vitest';

import { WireDiagnosticsSession } from '../wire-diagnostics.js';
import type { AnthropicMessagesRequest, BridgeLogger, ResponsesRequest } from '../types.js';

const meta = {
  requestId: 42,
  bridgeReqId: 7,
  wireModel: 'grok-4.6',
  realModel: 'grok-4.6',
  providerPrefix: 'xai/',
  downstreamStreaming: true,
};

function capture(): { logger: BridgeLogger; entries: Array<{ message: string; meta?: Record<string, unknown> }> } {
  const entries: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  return {
    entries,
    logger: {
      debug: (message, diagnosticMeta) => entries.push({ message, meta: diagnosticMeta }),
    },
  };
}

function requestAndResponseTools(): {
  request: AnthropicMessagesRequest;
  responses: ResponsesRequest;
} {
  const schema = {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  };
  return {
    request: {
      model: 'xai/grok-4.6',
      system: 'SECRET_PROMPT_SHOULD_NOT_BE_LOGGED',
      messages: [],
      tools: [{
        name: 'Edit',
        description: 'SECRET_DESCRIPTION_SHOULD_NOT_BE_LOGGED',
        input_schema: schema,
      }],
    },
    responses: {
      model: 'grok-4.6',
      input: [],
      store: false,
      stream: true,
      tools: [{
        type: 'function',
        name: 'Edit',
        strict: false,
        parameters: schema,
      }],
    },
  };
}

function addUpstreamCall(probe: WireDiagnosticsSession, args: string): void {
  probe.recordUpstreamEvent({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', name: 'Edit', call_id: 'call_1' },
  });
  probe.recordUpstreamEvent({
    type: 'response.function_call_arguments.delta',
    output_index: 0,
    delta: args,
  });
  probe.recordUpstreamEvent({
    type: 'response.function_call_arguments.done',
    output_index: 0,
    arguments: args,
  });
  probe.recordUpstreamEvent({
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'function_call', name: 'Edit', call_id: 'call_1', arguments: args },
  });
}

function addDownstreamCall(probe: WireDiagnosticsSession, args: string): void {
  probe.recordDownstreamEvent({
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_1', name: 'Edit', input: {} },
    },
  });
  probe.recordDownstreamEvent({
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: args },
    },
  });
  probe.recordDownstreamEvent({
    event: 'content_block_stop',
    data: { type: 'content_block_stop', index: 0 },
  });
}

function comparison(entries: Array<{ message: string; meta?: Record<string, unknown> }>): Record<string, unknown> {
  const entry = entries.find(({ message }) => message === 'wire diagnostics: bridge comparison');
  expect(entry?.meta).toBeDefined();
  return entry!.meta!;
}

describe('WireDiagnosticsSession', () => {
  it('detects an upstream missing required field preserved by the bridge', () => {
    const { logger, entries } = capture();
    const probe = new WireDiagnosticsSession(logger, meta);
    const { request, responses } = requestAndResponseTools();
    probe.recordRequest(request, responses);

    const malformed = JSON.stringify({ old_string: 'old', new_string: 'new' });
    addUpstreamCall(probe, malformed);
    addDownstreamCall(probe, malformed);
    probe.finish({ status: 200, reason: 'stream-finished' });

    const result = comparison(entries);
    const item = (result.comparisons as Array<Record<string, unknown>>)[0];
    expect(item.verdict).toBe('bridge-preserved');
    expect((item.upstreamArguments as Record<string, unknown>).missingRequired).toEqual(['file_path']);
    expect((item.downstreamArguments as Record<string, unknown>).missingRequired).toEqual(['file_path']);
    expect((entries.find(({ message }) => message === 'wire diagnostics: bridge request')!.meta!.responsesTools as Array<Record<string, unknown>>)[0].required)
      .toEqual(['file_path', 'new_string', 'old_string']);
    expect((entries.find(({ message }) => message === 'wire diagnostics: bridge request')!.meta!.responsesTools as Array<Record<string, unknown>>)[0].strict)
      .toBe(false);
  });

  it('distinguishes a downstream assembly difference from an upstream malformed call', () => {
    const { logger, entries } = capture();
    const probe = new WireDiagnosticsSession(logger, meta);
    const { request, responses } = requestAndResponseTools();
    probe.recordRequest(request, responses);

    const complete = JSON.stringify({ file_path: '/tmp/secret.txt', old_string: 'old', new_string: 'new' });
    const incomplete = JSON.stringify({ old_string: 'old', new_string: 'new' });
    addUpstreamCall(probe, complete);
    addDownstreamCall(probe, incomplete);
    probe.finish({ status: 200, reason: 'stream-finished' });

    const item = (comparison(entries).comparisons as Array<Record<string, unknown>>)[0];
    expect(item.verdict).toBe('bridge-output-differs-or-assembly-incomplete');
    expect((item.upstreamArguments as Record<string, unknown>).missingRequired).toEqual([]);
    expect((item.downstreamArguments as Record<string, unknown>).missingRequired).toEqual(['file_path']);
  });

  it('only emits shape metadata and never raw prompt, path, or argument values', () => {
    const { logger, entries } = capture();
    const probe = new WireDiagnosticsSession(logger, meta);
    const { request, responses } = requestAndResponseTools();
    probe.recordRequest(request, responses);
    const secretArguments = JSON.stringify({
      file_path: '/Users/dash/private/very-secret.txt',
      old_string: 'PRIVATE_OLD_CONTENT',
      new_string: 'PRIVATE_NEW_CONTENT',
      token: 'BEARER_SECRET_VALUE',
    });
    addUpstreamCall(probe, secretArguments);
    addDownstreamCall(probe, secretArguments);
    probe.finish({ status: 200, reason: 'stream-finished' });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('SECRET_PROMPT_SHOULD_NOT_BE_LOGGED');
    expect(serialized).not.toContain('SECRET_DESCRIPTION_SHOULD_NOT_BE_LOGGED');
    expect(serialized).not.toContain('/Users/dash/private/very-secret.txt');
    expect(serialized).not.toContain('PRIVATE_OLD_CONTENT');
    expect(serialized).not.toContain('PRIVATE_NEW_CONTENT');
    expect(serialized).not.toContain('BEARER_SECRET_VALUE');
    expect(serialized).toContain('file_path');
    expect(serialized).toContain('missingRequired');
  });
});
