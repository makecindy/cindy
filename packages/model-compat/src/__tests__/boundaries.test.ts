import { describe, expect, it } from 'vitest';
import { resolveProviderCompatibilityProfile } from '../profiles';
import { createCodexResponsesCompatibilityAdapter, prepareResponsesCompatibility, normalizeProviderRequest, chatCompatibilityCapabilities, sanitizeXaiTools } from '../index';

describe('protocol data boundaries', () => {
  it('does not rewrite custom-shaped literals in schemas, metadata or tool output', () => {
    const literal = { type: 'custom', name: 'run', description: 'literal value' };
    const body = {
      tools: [{ type: 'custom', name: 'run', description: 'actual tool' },
        { type: 'function', name: 'save', parameters: { type: 'object', properties: { payload: { default: literal } } } }],
      metadata: literal,
      input: [{ type: 'function_call_output', call_id: 'ordinary', output: literal }],
    };
    const prepared = prepareResponsesCompatibility(body, { customTools: 'functions' });
    const result = prepared.body as typeof body;
    expect(result.tools[0]!.type).toBe('function');
    expect(result.tools[1]).toEqual(body.tools[1]);
    expect(result.metadata).toBe(literal);
    expect(result.input[0]!.output).toBe(literal);
    expect(body.tools[0]!.type).toBe('custom');
  });
  it('does not infer namespace support from a provider-shaped model name', () => {
    const adapter = createCodexResponsesCompatibilityAdapter();
    const body = { model: 'xai/grok-4.6', tools: [{ type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'read' }] }] };
    expect(adapter.adaptRequest(body, 1, { harness: 'codex', protocol: 'openai-responses', upstreamBase: 'https://proxy.example/v1', model: 'xai/grok-4.6' })).toBeNull();
    adapter.releaseResponse(1);
  });
  it('releases both adapter mappings after an invalid response encoding', () => {
    const adapter = createCodexResponsesCompatibilityAdapter();
    adapter.adaptRequest({ tools: [{ type: 'custom', name: 'exec', description: 'JavaScript' }] }, 7);
    expect(() => adapter.createResponseTransform(7, { contentType: 'application/json', contentEncoding: 'gzip' })).toThrow();
    expect(adapter.createResponseTransform(7, { contentType: 'application/json', contentEncoding: '' })).toBeNull();
  });
  it('uses DeepSeek declarations for the endpoint and keeps explicit route capabilities', () => {
    const route = { harness: 'codex' as const, protocol: 'openai-chat' as const, upstreamBase: 'https://api.deepseek.com', model: 'deepseek-v4-pro' };
    const capabilities = chatCompatibilityCapabilities(route, { parallelToolCalls: false });
    expect(capabilities.parallelToolCalls).toBe(false);
    const body = { model: route.model, reasoning_effort: 'high' };
    const normalized = normalizeProviderRequest(body, route) as typeof body;
    expect(normalized.model).toBe(body.model);
    expect(normalizeProviderRequest(body, { ...route, upstreamBase: 'https://api.deepseek.com.evil.test' })).toBe(body);
  });
});

describe('provider replay regression', () => {
  const route = { harness: 'codex' as const, protocol: 'openai-responses' as const, upstreamBase: 'https://api.deepseek.com', model: 'deepseek-v4-pro' };
  it('normalizes DeepSeek search history and effort without discarding plaintext reasoning', () => {
    const body = { model: route.model, reasoning: { effort: 'medium' }, input: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'retained reasoning' }] },
      { type: 'web_search_call', action: { type: 'search', query: 'weather' } },
    ] };
    const result = normalizeProviderRequest(body, route) as typeof body & { store: boolean };
    expect(result.reasoning.effort).toBe('high');
    expect(result.store).toBe(false);
    expect(result.input[0]).toBe(body.input[0]);
    expect(result.input[1]!.action).toEqual({ type: 'search', query: 'weather', queries: ['weather'] });
    expect(body.reasoning.effort).toBe('medium');
  });
  it('keeps parallel calls grouped with their results and explicitly annotates empty output', () => {
    const call = { type: 'function_call', call_id: 'a', name: 'read', arguments: '{}' };
    const message = { type: 'message', role: 'assistant', content: [] };
    const result = normalizeProviderRequest({ input: [call, message, { type: 'function_call_output', call_id: 'a', output: '' }] }, route) as { input: Array<Record<string, unknown>> };
    expect(result.input[0]).toBe(call);
    expect(result.input[1]!.type).toBe('function_call_output');
    expect(result.input[1]!.output).toBe('[ocx] empty tool output: the tool ran but produced no stdout or return value; do not treat this as success, failure, or user-provided input.');
    expect(result.input[2]).toBe(message);
  });
  it('rejects a stateless continuation whose history has not been expanded', () => {
    expect(() => normalizeProviderRequest({ previous_response_id: 'resp_missing' }, route)).toThrow(/expanded/);
  });
  it('converts apply_patch for the actual xAI subscription endpoint', () => {
    const adapter = createCodexResponsesCompatibilityAdapter();
    const body = { tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }] };
    const result = adapter.adaptRequest(body, 1, { ...route, model: 'grok-4.6', upstreamBase: 'https://cli-chat-proxy.grok.com/v1' }, true) as typeof body;
    expect(result.tools[0]!.type).toBe('function');
    adapter.releaseResponse(1);
  });
});


it('cleans both xAI tool catalogs without retaining a removed top-level declaration', () => {
  const body = { tools: [{ type: 'unsupported' }], input: [{ type: 'additional_tools', tools: [{ type: 'function', name: 'read' }, { type: 'unsupported' }] }], tool_choice: { type: 'function', name: 'read' } };
  const result = sanitizeXaiTools(body)!;
  expect(result).not.toHaveProperty('tools');
  expect(result.input).toEqual([{ type: 'additional_tools', tools: [{ type: 'function', name: 'read' }] }]);
  expect(result.tool_choice).toEqual(body.tool_choice);
  expect(body.tools).toEqual([{ type: 'unsupported' }]);
});


it('preserves an explicit native Chat reasoning disable when no provider wire map overrides it', () => {
  const input = { model: 'gpt-5.4', reasoning_effort: 'none' };
  expect(normalizeProviderRequest(input, { harness: 'codex', protocol: 'openai-chat', upstreamBase: 'https://api.openai.com/v1', model: input.model })).toEqual(input);
});

describe('same-endpoint provider profiles', () => {
  const kimi = { harness: 'codex' as const, protocol: 'openai-chat' as const, upstreamBase: 'https://api.kimi.com/coding/v1', model: 'k3[1m]' };
  it.each([undefined, 'oauth', 'api-key'] as const)('applies Kimi wire fixes with auth mode %s', authMode => {
    const route = { ...kimi, authMode };
    const body = { model: 'k3[1m]', temperature: 0.7, top_p: 0.9, frequency_penalty: 1, presence_penalty: 1, reasoning_effort: 'high', messages: [] };
    expect(normalizeProviderRequest(body, route)).toEqual({ model: 'k3', messages: [] });
    expect(chatCompatibilityCapabilities(route)).toMatchObject({ reasoningHistoryField: 'reasoning_content', toolCallReasoningPlaceholder: true });
    expect(resolveProviderCompatibilityProfile(route)?.id).toBe(authMode === 'api-key' ? 'kimi-code' : 'kimi');
  });
  it('shares identical key profiles and preserves explicit bridge overrides', () => {
    const route = { ...kimi, upstreamBase: 'https://api.fireworks.ai/inference/v1', authMode: 'api-key' as const };
    expect(resolveProviderCompatibilityProfile(route)).not.toBeNull();
    expect(chatCompatibilityCapabilities(kimi, { toolCallReasoningPlaceholder: false }).toolCallReasoningPlaceholder).toBe(false);
  });
  it('does not guess between conflicting policies or match a lookalike endpoint', () => {
    expect(resolveProviderCompatibilityProfile({ ...kimi, upstreamBase: 'https://opencode.ai/zen/v1', authMode: 'api-key' })).toBeNull();
    expect(resolveProviderCompatibilityProfile({ ...kimi, upstreamBase: 'https://api.kimi.com/coding/v10' })).toBeNull();
    expect(resolveProviderCompatibilityProfile({ ...kimi, upstreamBase: 'https://api.kimi.com.example/coding/v1' })).toBeNull();
  });
});
