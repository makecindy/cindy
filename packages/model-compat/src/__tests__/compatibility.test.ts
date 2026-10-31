import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createCodexResponsesCompatibilityAdapter, normalizeProviderRequest, prepareResponsesCompatibility, resolveProviderCompatibilityProfile, sanitizeGeminiToolParameters, sanitizeXaiTools, hasCacheOnlySearchProhibition } from '../index';

async function responseText(transform: NodeJS.ReadWriteStream, text: string) {
  const output: Buffer[] = [];
  const done = new Promise<string>((resolve, reject) => {
    transform.on('data', chunk => output.push(Buffer.from(chunk)));
    transform.on('error', reject);
    transform.on('end', () => resolve(Buffer.concat(output).toString()));
  });
  Readable.from([...Buffer.from(text)].map(byte => Buffer.from([byte]))).pipe(transform);
  return done;
}

describe('request-owned Responses compatibility', () => {
  it.each(['application/json', 'text/event-stream'])('restores namespace and Code Mode identities (%s)', async contentType => {
    const adapter = createCodexResponsesCompatibilityAdapter();
    const input = {
      model: 'xai/grok-4.6',
      tools: [
        { type: 'custom', name: 'exec', description: 'Run JavaScript' },
        { type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] },
      ],
    };
    const request = adapter.adaptRequest(input, 1, { harness: 'codex', protocol: 'openai-responses', upstreamBase: 'https://cli-chat-proxy.grok.com/v1', model: 'grok-4.6' }, true) as typeof input;
    expect(request.tools.map(tool => tool.name)).toEqual(['exec', 'files__read']);
    const result = { id: 'resp_test', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'a', name: 'exec', arguments: JSON.stringify({ input: 'text("你好")' }) },
      { type: 'function_call', id: 'fc_b', call_id: 'b', name: 'files__read', arguments: '{"path":"README.md"}' },
    ] };
    const sse = contentType === 'text/event-stream';
    const wire = sse ? `data: ${JSON.stringify({ type: 'response.completed', response: result })}\n\n` : JSON.stringify(result);
    const transformed = await responseText(adapter.createResponseTransform(1, { contentType, contentEncoding: '' })!, wire);
    const parsed = JSON.parse(sse ? transformed.trim().slice(6) : transformed);
    const response = sse ? parsed.response : parsed;
    expect(response.output[0]).toMatchObject({ type: 'custom_tool_call', call_id: 'a', name: 'exec', input: 'text("你好")' });
    expect(response.output[1]).toMatchObject({ type: 'function_call', call_id: 'b', namespace: 'files', name: 'read' });
    expect(input.tools[1]!.type).toBe('namespace');
  });

  it('keeps native GPT namespaces and no-op response bodies unchanged', () => {
    const input = { model: 'gpt-5.4', tools: [{ type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'read' }] }] };
    const adapter = createCodexResponsesCompatibilityAdapter();
    expect(adapter.adaptRequest(input, 1)).toBeNull();
    adapter.releaseResponse(1);
    expect(adapter.createResponseTransform(1, { contentType: 'application/json', contentEncoding: '' })).toBeNull();
  });

  it('restores tool discovery independently from web search', () => {
    const prepared = prepareResponsesCompatibility({ tools: [{ type: 'tool_search' }] }, { toolSearch: 'function' });
    const body = prepared.body as { tools: Array<{ name: string }> };
    const output = JSON.parse(prepared.restoreJson(JSON.stringify({ output: [{ type: 'function_call', name: body.tools[0]!.name, call_id: 'a', arguments: '{"query":"read files"}' }] })));
    expect(output.output[0].type).toBe('tool_search_call');
  });
});

describe('provider policy boundaries across harnesses', () => {
  it.each(['codex', 'claude-code', 'pi'] as const)('only normalizes an actual xAI Responses endpoint for %s', harness => {
    const body = { tools: [{ type: 'web_search', external_web_access: true, user_location: { country: 'CN' } }] };
    const route = { harness, protocol: 'openai-responses' as const, upstreamBase: 'https://api.x.ai/v1', model: 'grok-4.6' };
    expect(normalizeProviderRequest(body, route)).toEqual({ tools: [{ type: 'web_search', user_location: { country: 'CN' } }] });
    expect(normalizeProviderRequest(body, { ...route, upstreamBase: 'https://api.x.ai.evil.test/v1' })).toBe(body);
    expect(normalizeProviderRequest(body, { ...route, protocol: 'openai-chat' })).toBe(body);
  });
  it.each([false, null, 'false'])('does not widen an explicit non-live search declaration (%s)', external_web_access => {
    const body = { tools: [{ type: 'function', name: 'read' }], input: [{ type: 'additional_tools', tools: [{ type: 'web_search_preview', external_web_access }] }], tool_choice: { type: 'web_search_preview' } };
    expect(hasCacheOnlySearchProhibition(body)).toBe(true);
    expect(sanitizeXaiTools(body)).toMatchObject({ tools: [{ type: 'function', name: 'read' }], tool_choice: 'none', input: [] });
  });
  it('strips subscription-only schema markers without touching literals or the public xAI API', () => {
    const parameters = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { encrypted: { type: 'string', default: 'encrypted' } }, additionalProperties: false };
    const body = { tools: [{ type: 'function', name: 'read', parameters }] };
    const route = { harness: 'claude-code' as const, protocol: 'openai-responses' as const, model: 'grok-4.6', upstreamBase: 'https://cli-chat-proxy.grok.com/v1' };
    const output = normalizeProviderRequest(body, route) as typeof body;
    expect(output.tools[0]!.parameters).not.toHaveProperty('$schema');
    expect(output.tools[0]!.parameters.properties.encrypted.default).toBe('encrypted');
    expect(normalizeProviderRequest(body, { ...route, upstreamBase: 'https://api.x.ai/v1' })).toBe(body);
  });
  it('does not inherit compatibility by a familiar model name on an unknown gateway', () => {
    expect(resolveProviderCompatibilityProfile({ harness: 'codex', protocol: 'openai-responses', model: 'deepseek-v4-pro', upstreamBase: 'https://gateway.example/v1' })).toBeNull();
  });
});

describe('Gemini legacy function schema container types (#7843)', () => {
  it('removes the generic JSON union items without losing the enclosing array', () => {
    const jsonValue = { type: ['null', 'boolean', 'object', 'array', 'number', 'string'], items: {} };
    const input = { type: 'object', properties: { values: { type: 'array', items: jsonValue } } };
    expect(sanitizeGeminiToolParameters(input)).toEqual({
      type: 'object', properties: { values: { type: 'array', items: { type: 'boolean', nullable: true } } },
    });
    expect(input.properties.values.items).toEqual(jsonValue);
    expect(jsonValue.items).toEqual({});
  });

  it.each(['string', 'number', 'integer', 'boolean', 'object', 'null', undefined])(
    'does not emit array items for type %s', type => {
      const out = sanitizeGeminiToolParameters({ properties: { value: { type, items: { type: 'string' } } } });
      expect((out.properties as Record<string, Record<string, unknown>>).value).not.toHaveProperty('items');
    },
  );

  it('preserves nested arrays, nullable array unions, and referenced array items', () => {
    expect(sanitizeGeminiToolParameters({
      type: 'object',
      $defs: { Value: { type: ['null', 'boolean', 'array'], items: {} } },
      properties: {
        values: { type: ['null', 'array'], items: { $ref: '#/$defs/Value' } },
        composed: { items: { type: 'string' }, anyOf: [{ type: 'array' }, { type: 'null' }] },
        matrix: { anyOf: [{ type: 'array', items: { type: 'array', items: { type: 'string' } } }, { type: 'null' }] },
      },
    })).toEqual({ type: 'object', properties: {
      values: { type: 'array', nullable: true, items: { type: 'boolean', nullable: true } },
      composed: { type: 'array', nullable: true, items: { type: 'string' } },
      matrix: { type: 'array', nullable: true, items: { type: 'array', items: { type: 'string' } } },
    } });
  });

  it('drops stale items after composition changes the emitted type', () => {
    const out = sanitizeGeminiToolParameters({ properties: { value: {
      type: 'array', items: { type: 'string' }, anyOf: [{ type: 'string' }, { type: 'null' }],
    } } });
    expect(out).toEqual({ type: 'object', properties: { value: { type: 'string', nullable: true } } });
  });

  it('still removes non-array items when their subtree exhausts the schema budget', () => {
    const properties = Object.fromEntries(Array.from({ length: 1024 }, (_, i) => [String(i), { type: 'string' }]));
    expect(sanitizeGeminiToolParameters({ properties: { value: { type: 'boolean', items: { type: 'object', properties } } } }))
      .toEqual({ type: 'object', properties: { value: { type: 'boolean' } } });
  });

  it('drops root array items when enforcing object function arguments', () => {
    expect(sanitizeGeminiToolParameters({ type: 'array', items: { type: 'string' } }))
      .toEqual({ type: 'object', properties: {} });
  });
});
