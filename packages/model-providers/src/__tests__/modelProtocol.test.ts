import { describe, expect, it } from 'vitest';
import { modelProtocolComparison, nativeModelAgents } from '../modelProtocol.js';
import { pickRecommendedAgent, resolveAgentCapability } from '../unifiedSelection.js';
import type { CatalogModel, PiModelApi, Provider } from '../types.js';

const model: CatalogModel = {
  id: 'future/model',
  name: 'Future',
  contextWindow: 1048576,
  efforts: [],
  defaultEffort: null,
};
function fixture(api?: PiModelApi) {
  const byAgent: Record<'claude-code' | 'codex' | 'pi', CatalogModel> = {
    'claude-code': { ...model },
    codex: { ...model },
    pi: { ...model, ...(api ? { piApi: api, nativeApi: api } : {}) },
  };
  const provider = {
    id: 'xd',
    agents: ['claude-code', 'codex', 'pi'],
    routing: {
      'claude-code': { wireProtocol: 'anthropic-messages' },
      codex: { wireProtocol: 'openai-responses' },
      pi: { wireProtocol: 'openai-responses' },
    },
    models: Object.fromEntries(Object.entries(byAgent).map(([agent, entry]) => [agent, [entry]])),
  } as Provider;
  return { provider, byAgent };
}

describe('per-model protocol comparison', () => {
  // Chris 2026-10-30: an API the upstream offers is used as is, even when the gateway
  // serves it for another vendor's model. Only Cindy's local conversion is compatibility.
  it('treats every Gateway front door as offered and still recommends Pi for a Google model', () => {
    const { provider, byAgent } = fixture('google-generative-ai');
    const result = modelProtocolComparison(provider, byAgent);
    expect(result.reference).toBe('google-generative-ai');
    expect(result.forAgent('claude-code')).toMatchObject({
      harness: 'anthropic-messages',
      outbound: 'anthropic-messages',
      mode: 'matching',
      localConversion: false,
    });
    expect(result.forAgent('codex')).toMatchObject({
      harness: 'openai-responses',
      outbound: 'openai-responses',
      mode: 'matching',
      localConversion: false,
    });
    expect(result.upstreamApis).toEqual(['anthropic-messages', 'openai-responses', 'google-generative-ai']);
    expect(result.forAgent('pi')).toMatchObject({
      harness: 'google-generative-ai',
      outbound: 'google-generative-ai',
      mode: 'matching',
    });
    expect(pickRecommendedAgent(provider, model.id, provider.agents)).toBe('pi');
    expect(pickRecommendedAgent(provider, model.id, ['claude-code', 'codex'])).toBe('claude-code');
  });

  it.each(['openai-chat', 'openai-responses'] as const)(
    'marks a Chat Completions model as compatibility only when Codex converts locally (%s)',
    (wireProtocol) => {
      const { provider, byAgent } = fixture('openai-completions');
      provider.routing.codex!.wireProtocol = wireProtocol;
      const mode = wireProtocol === 'openai-chat' ? 'compatibility' : 'matching';
      expect(modelProtocolComparison(provider, byAgent).forAgent('codex')).toMatchObject({
        harness: 'openai-responses',
        outbound: wireProtocol === 'openai-chat' ? 'openai-completions' : 'openai-responses',
        localConversion: wireProtocol === 'openai-chat',
        mode,
      });
      expect(resolveAgentCapability([{ ...provider, connected: true }], 'xd', model.id, 'codex')?.protocolMode)
        .toBe(mode);
    },
  );

  it('does not infer a native Google route or recommendation from a Gemini name', () => {
    const { provider, byAgent } = fixture('openai-responses');
    for (const entry of Object.values(byAgent)) entry.id = 'google/gemini-future';
    expect(pickRecommendedAgent(provider, 'google/gemini-future', provider.agents)).toBe('codex');
    expect(modelProtocolComparison(provider, byAgent).forAgent('pi')?.outbound).toBe(
      'openai-responses',
    );
  });

  it('only recommends a native candidate when its effective route also matches', () => {
    const { provider, byAgent } = fixture('openai-responses');
    byAgent.codex.route = {
      baseUrl: 'https://example.invalid',
      wireProtocol: 'anthropic-messages',
    };
    expect(pickRecommendedAgent(provider, model.id, provider.agents)).toBe('pi');
    byAgent.pi.nativeApi = 'google-generative-ai';
    expect(modelProtocolComparison(provider, byAgent).forAgent('pi')?.mode).toBe('matching');
    expect(pickRecommendedAgent(provider, model.id, provider.agents)).toBe('pi');
  });

  it('uses model route overrides for local conversion, ignoring obsolete compatibility annotations', () => {
    const { provider, byAgent } = fixture('anthropic-messages');
    const codex = {
      ...model,
      route: {
        baseUrl: 'https://example.invalid',
        wireProtocol: 'anthropic-messages' as const,
      },
    };
    expect(
      modelProtocolComparison(provider, { ...byAgent, codex }).forAgent('codex'),
    ).toMatchObject({
      harness: 'openai-responses',
      outbound: 'anthropic-messages',
      mode: 'compatibility',
      localConversion: true,
    });
    expect(
      modelProtocolComparison(provider, {
        ...byAgent,
        codex: { ...model, codexCompatibilityWireProtocol: 'openai-chat' },
      }).forAgent('codex')?.outbound,
    ).toBe('openai-responses');
  });

  // Local conversion changes the engine side only; the API it reaches is still one the upstream serves.
  it('lists a converted outbound API among upstream APIs', () => {
    const claude = { ...model, route: { baseUrl: 'https://example.invalid/v1', wireProtocol: 'openai-chat' as const } };
    const provider = { id: 'custom', source: 'user', agents: ['claude-code'], routing: {}, models: { 'claude-code': [claude] } } as unknown as Provider;
    const result = modelProtocolComparison(provider, { 'claude-code': claude });
    expect(result.forAgent('claude-code')).toMatchObject({ outbound: 'openai-completions', localConversion: true });
    expect(result.upstreamApis).toEqual(['openai-completions']);
  });

  it('projects protocol support with the same provider and real bridge model identity', () => {
    const { provider } = fixture('google-generative-ai');
    const other = {
      ...provider,
      id: 'other',
      models: { codex: [{ ...model, nativeApi: 'openai-responses' as const }] },
    };
    const providers = [
      { ...provider, connected: true },
      { ...other, connected: true },
    ];
    expect(resolveAgentCapability(providers, 'xd', model.id, 'pi')).toMatchObject({
      protocolMode: 'matching',
      nativeApi: 'google-generative-ai',
      outboundApi: 'google-generative-ai',
    });
    expect(resolveAgentCapability(providers, 'xd', model.id, 'codex')).toMatchObject({
      protocolMode: 'matching',
      nativeApi: 'google-generative-ai',
      outboundApi: 'openai-responses',
    });
    expect(resolveAgentCapability(providers, 'other', model.id, 'codex')?.protocolMode).toBe(
      'matching',
    );
    // The ChatGPT subscription bridge converts Claude Code requests locally to Responses.
    const subscription = {
      ...provider,
      id: 'openai',
      source: 'builtin' as const,
      connected: true,
      models: {
        codex: [{ ...model, id: 'gpt-test' }],
        'claude-code': [{ ...model, id: 'chatgpt/gpt-test' }],
      },
    };
    expect(
      resolveAgentCapability([subscription], 'openai', 'gpt-test', 'claude-code'),
    ).toMatchObject({
      wireModelId: 'chatgpt/gpt-test',
      protocolMode: 'compatibility',
      outboundApi: 'openai-responses',
    });
  });

  it('keeps absent declarations unknown and does not invent a route in redacted views', () => {
    const { provider, byAgent } = fixture();
    const result = modelProtocolComparison(provider, byAgent);
    expect(result.reference).toBeNull();
    expect(result.forAgent('pi')?.mode).toBe('matching');
    expect(
      modelProtocolComparison(
        { id: 'xd', routing: { codex: {} } as Provider['routing'] },
        byAgent,
      ).forAgent('codex')?.outbound,
    ).toBeNull();
    expect(modelProtocolComparison(provider, {}).forAgent('pi')).toBeNull();
  });
});


describe('custom supplier transport ownership', () => {
  it.each(['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai', 'bedrock-converse-stream', 'azure-openai-responses', 'google-vertex', 'mistral-conversations'] as const)(
    'Pi uses %s directly; only mismatching fixed-protocol harnesses require conversion', api => {
      const { provider, byAgent } = fixture('google-generative-ai');
      provider.source = 'user';
      for (const model of Object.values(byAgent)) { model.api = api; model.nativeApi = api; }
      const result = modelProtocolComparison(provider, byAgent);
      expect(result.forAgent('pi')).toMatchObject({ outbound: api, mode: 'matching', localConversion: false });
      expect(result.forAgent('claude-code')?.mode).toBe(api === 'anthropic-messages' ? 'matching' : 'compatibility');
      expect(result.forAgent('codex')?.mode).toBe(['openai-responses', 'azure-openai-responses'].includes(api) ? 'matching' : 'compatibility');
    },
  );

  it('enables every engine whose front door the Gateway offers (Gateway, user supplier)', () => {
    for (const source of [undefined, 'user'] as const) {
      const { provider, byAgent } = fixture('google-generative-ai');
      if (source) provider.source = source;
      byAgent.pi.api = 'openai-completions';
      const comparison = modelProtocolComparison(provider, byAgent);
      expect(comparison.forAgent('claude-code')).toMatchObject({ mode: 'matching', localConversion: false });
      expect(comparison.forAgent('codex')).toMatchObject({ mode: 'matching', localConversion: false });
      expect(comparison.forAgent('pi')).toMatchObject({ mode: 'matching', outbound: 'openai-completions' });
      expect(nativeModelAgents(provider, byAgent)).toEqual(['claude-code', 'codex', 'pi']);
    }
  });

  it('keeps a built-in subscription bridge in compatibility mode and off by default', () => {
    const { provider, byAgent } = fixture('openai-responses');
    provider.id = 'openai';
    provider.source = 'builtin';
    const comparison = modelProtocolComparison(provider, byAgent);
    expect(comparison.forAgent('claude-code')).toMatchObject({ outbound: 'openai-responses', mode: 'compatibility' });
    expect(comparison.forAgent('pi')).toMatchObject({ outbound: 'openai-responses', mode: 'matching' });
    expect(nativeModelAgents(provider, byAgent)).toEqual(['codex', 'pi']);
  });
});
