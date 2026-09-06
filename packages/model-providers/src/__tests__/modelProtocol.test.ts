import { describe, expect, it } from 'vitest';
import { modelProtocolComparison } from '../modelProtocol.js';
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
  it('compares a newly delivered Google API with both compatibility harnesses and recommends Pi', () => {
    const { provider, byAgent } = fixture('google-generative-ai');
    const result = modelProtocolComparison(provider, byAgent);
    expect(result.reference).toBe('google-generative-ai');
    expect(result.forAgent('claude-code')).toMatchObject({
      harness: 'anthropic-messages',
      outbound: 'anthropic-messages',
      mode: 'compatibility',
      localConversion: false,
    });
    expect(result.forAgent('codex')).toMatchObject({
      harness: 'openai-responses',
      outbound: 'openai-responses',
      mode: 'compatibility',
      localConversion: false,
    });
    expect(result.forAgent('pi')).toMatchObject({
      harness: 'google-generative-ai',
      outbound: 'google-generative-ai',
      mode: 'matching',
    });
    expect(pickRecommendedAgent(provider, model.id, provider.agents)).toBe('pi');
    expect(pickRecommendedAgent(provider, model.id, ['claude-code', 'codex'])).toBe('claude-code');
  });

  it.each(['openai-chat', 'openai-responses'] as const)(
    'marks Chat Completions via %s as compatibility without misreporting the native CLI transport',
    (wireProtocol) => {
      const { provider, byAgent } = fixture('openai-completions');
      provider.routing.codex!.wireProtocol = wireProtocol;
      expect(modelProtocolComparison(provider, byAgent).forAgent('codex')).toMatchObject({
        harness: 'openai-responses',
        outbound: wireProtocol === 'openai-chat' ? 'openai-completions' : 'openai-responses',
        localConversion: wireProtocol === 'openai-chat',
        mode: 'compatibility',
      });
      expect(resolveAgentCapability([{ ...provider, connected: true }], 'xd', model.id, 'codex')?.protocolMode)
        .toBe('compatibility');
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
    expect(modelProtocolComparison(provider, byAgent).forAgent('pi')?.mode).toBe('compatibility');
    expect(pickRecommendedAgent(provider, model.id, provider.agents)).toBe('claude-code');
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
      protocolMode: 'compatibility',
      nativeApi: 'google-generative-ai',
      outboundApi: 'openai-responses',
    });
    expect(resolveAgentCapability(providers, 'other', model.id, 'codex')?.protocolMode).toBe(
      'matching',
    );
    const subscription = {
      ...provider,
      id: 'openai',
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
    });
  });

  it('keeps absent declarations unknown and does not invent a route in redacted views', () => {
    const { provider, byAgent } = fixture();
    const result = modelProtocolComparison(provider, byAgent);
    expect(result.reference).toBeNull();
    expect(result.forAgent('pi')?.mode).toBe('unknown');
    expect(
      modelProtocolComparison(
        { id: 'xd', routing: { codex: {} } as Provider['routing'] },
        byAgent,
      ).forAgent('codex')?.outbound,
    ).toBeNull();
    expect(modelProtocolComparison(provider, {}).forAgent('pi')).toBeNull();
  });
});
