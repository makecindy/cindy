import type { AgentKind } from '@cindy/maker-core';
import { describe, expect, it } from 'vitest';

import type { OrcaWorkerProviderRoutingContext } from '../orcaWorkerCreationService';
import { resolveSendToSessionExecutionConfig } from '../sendToSessionExecutionConfig';

const available = (agent: AgentKind) => (
  agent === 'codex'
    ? [
        {
          id: 'gpt-5.6-sol',
          efforts: ['high', 'xhigh', 'max', 'ultra'],
          defaultEffort: 'xhigh',
          supportsFastMode: true,
        },
      ]
    : agent === 'pi'
      ? [
          {
            id: 'pi-model',
            efforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
            supportsFastMode: true,
          },
        ]
      : [
        {
          id: 'claude-fable-5',
          efforts: ['high'],
          defaultEffort: 'high',
          supportsFastMode: false,
        },
        {
          id: 'claude-opus-fast',
          efforts: ['high'],
          defaultEffort: 'high',
          supportsFastMode: true,
        },
      ]
);

const fableSource = () => ({
  agentKind: 'claude-code' as const,
  model: 'claude-fable-5',
  effort: 'high' as const,
  fastMode: false,
  providerId: 'anthropic',
});

const providerRouting = (
  defaults: Partial<Record<AgentKind, string>> = {},
): OrcaWorkerProviderRoutingContext => ({
  availability: {
    'claude-code': [{
      id: 'anthropic',
      name: 'Anthropic',
      models: ['claude-fable-5', 'claude-opus-fast'],
      fastModels: ['claude-opus-fast'],
      effortMetaByModel: {
        'claude-fable-5': { efforts: ['high'], defaultEffort: 'high' },
        'claude-opus-fast': { efforts: ['high'], defaultEffort: 'high' },
      },
    }],
    codex: [{
      id: 'openai',
      name: 'OpenAI',
      models: ['gpt-5.6-sol'],
      fastModels: ['gpt-5.6-sol'],
      effortMetaByModel: {
        'gpt-5.6-sol': {
          efforts: ['high', 'xhigh', 'max', 'ultra'],
          defaultEffort: 'xhigh',
        },
      },
    }],
    pi: [{
      id: 'xd',
      name: 'Cindy AI',
      models: ['pi-model'],
      fastModels: ['pi-model'],
      effortMetaByModel: {
        'pi-model': { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      },
    }],
  },
  resolveDefaultProviderIdForModel: (agent: AgentKind) => defaults[agent] ?? (
    agent === 'claude-code' ? 'anthropic' : agent === 'codex' ? 'openai' : 'xd'
  ),
});

const sourceFor = (agent: AgentKind) => {
  if (agent === 'claude-code') return fableSource();
  if (agent === 'codex') {
    return {
      agentKind: 'codex' as const,
      model: 'gpt-5.6-sol',
      effort: 'xhigh' as const,
      fastMode: true,
      providerId: 'openai',
    };
  }
  return {
    agentKind: 'pi' as const,
    model: 'pi-model',
    effort: 'high' as const,
    fastMode: true,
    providerId: 'xd',
  };
};

const targetFor = (agent: AgentKind) => {
  if (agent === 'claude-code') {
    return {
      agentKind: 'claude-code' as const,
      model: 'claude-opus-fast',
      effort: 'high' as const,
      fastMode: true,
    };
  }
  if (agent === 'codex') {
    return {
      agentKind: 'codex' as const,
      model: 'gpt-5.6-sol',
      effort: 'max' as const,
      fastMode: true,
    };
  }
  return {
    agentKind: 'pi' as const,
    model: 'pi-model',
    effort: 'max' as const,
    fastMode: true,
  };
};

describe('resolveSendToSessionExecutionConfig', () => {
  it.each([
    ['claude-code', 'codex'],
    ['claude-code', 'pi'],
    ['codex', 'claude-code'],
    ['codex', 'pi'],
    ['pi', 'claude-code'],
    ['pi', 'codex'],
  ] satisfies ReadonlyArray<readonly [AgentKind, AgentKind]>) (
    'resolves %s → %s through the same target execution gateway',
    (sourceAgent, targetAgent) => {
      const target = targetFor(targetAgent);
      expect(resolveSendToSessionExecutionConfig({
        source: sourceFor(sourceAgent),
        overrides: target,
        availableModels: available(targetAgent),
        providerRouting: providerRouting(),
        hasCindyAiApiKey: true,
      })).toEqual({
        ok: true,
        config: {
          ...target,
          providerId: null,
        },
      });
    },
  );

  it('resolves Claude/Fable → Codex/gpt with explicit effort and clears the old provider', () => {
    expect(resolveSendToSessionExecutionConfig({
      source: fableSource(),
      overrides: {
        agentKind: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      },
      availableModels: available('codex'),
      providerRouting: providerRouting(),
      hasCindyAiApiKey: true,
    })).toEqual({
      ok: true,
      config: {
        agentKind: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        fastMode: false,
        providerId: null,
      },
    });
  });

  it('resolves Claude/Fable → Pi with provider-aware effort and Fast', () => {
    expect(resolveSendToSessionExecutionConfig({
      source: fableSource(),
      overrides: {
        agentKind: 'pi',
        model: 'pi-model',
        effort: 'max',
        fastMode: true,
      },
      availableModels: available('pi'),
      providerRouting: providerRouting(),
      hasCindyAiApiKey: true,
    })).toEqual({
      ok: true,
      config: {
        agentKind: 'pi',
        model: 'pi-model',
        effort: 'max',
        fastMode: true,
        providerId: null,
      },
    });
  });

  it('pins the default Pi BYOM route when another provider exposes the same model', () => {
    const routing = providerRouting({ pi: 'local-pi' });
    routing.availability.pi.push({
      id: 'local-pi',
      name: 'Local Pi',
      models: ['pi-model'],
      fastModels: ['pi-model'],
      effortMetaByModel: {
        'pi-model': { efforts: ['high', 'max'], defaultEffort: 'max' },
      },
      requiresExplicitRoute: true,
    });

    expect(resolveSendToSessionExecutionConfig({
      source: fableSource(),
      overrides: {
        agentKind: 'pi',
        model: 'pi-model',
        effort: 'max',
        fastMode: true,
      },
      availableModels: available('pi'),
      providerRouting: routing,
      hasCindyAiApiKey: true,
    })).toEqual({
      ok: true,
      config: {
        agentKind: 'pi',
        model: 'pi-model',
        effort: 'max',
        fastMode: true,
        providerId: 'local-pi',
      },
    });
  });

  it('fails closed when only Agent changes and the inherited model is unavailable', () => {
    expect(resolveSendToSessionExecutionConfig({
      source: fableSource(),
      overrides: { agentKind: 'codex' },
      availableModels: available('codex'),
      providerRouting: providerRouting(),
      hasCindyAiApiKey: true,
    })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
      message: expect.stringContaining('claude-fable-5'),
    });
  });

  it('rejects unsupported explicit effort and Fast values', () => {
    expect(resolveSendToSessionExecutionConfig({
      source: fableSource(),
      overrides: { effort: 'xhigh' },
      availableModels: available('claude-code'),
      providerRouting: providerRouting(),
      hasCindyAiApiKey: true,
    })).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });

    expect(resolveSendToSessionExecutionConfig({
      source: fableSource(),
      overrides: { fastMode: true },
      availableModels: available('claude-code'),
      providerRouting: providerRouting(),
      hasCindyAiApiKey: true,
    })).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  });

  it('keeps an explicit effort for a custom model whose capabilities were never declared (#5535)', () => {
    // 自定义来源只填了 id/name:目录与路由快照都没有档位声明,[] 只是占位,不是 valid: none。
    const undeclared = { id: 'custom/step-5-preview', efforts: [], defaultEffort: null, effortsUnknown: true };
    const routing: OrcaWorkerProviderRoutingContext = {
      availability: {
        codex: [], pi: [],
        'claude-code': [{
          id: 'custom-anthropic',
          name: 'Custom Anthropic Messages',
          models: [undeclared.id],
          effortMetaByModel: { [undeclared.id]: { efforts: [], defaultEffort: null, effortsUnknown: true } },
          requiresExplicitRoute: true,
        }],
      },
      resolveDefaultProviderIdForModel: (agent, model) =>
        agent === 'claude-code' && model === undeclared.id ? 'custom-anthropic' : null,
    };
    expect(resolveSendToSessionExecutionConfig({
      source: { agentKind: 'claude-code', model: undeclared.id, fastMode: false, providerId: 'custom-anthropic' },
      overrides: { effort: 'medium' },
      availableModels: [undeclared],
      providerRouting: routing,
      hasCindyAiApiKey: false,
    })).toEqual({
      ok: true,
      config: {
        agentKind: 'claude-code',
        model: undeclared.id,
        effort: 'medium',
        fastMode: false,
        providerId: 'custom-anthropic',
      },
    });

    // 明确无档位(已声明空表,无 effortsUnknown)仍按原规则拒绝显式档位。
    const declaredNone = { id: 'custom/no-reasoning', efforts: [], defaultEffort: null };
    expect(resolveSendToSessionExecutionConfig({
      source: { agentKind: 'claude-code', model: declaredNone.id, fastMode: false, providerId: 'custom-anthropic' },
      overrides: { effort: 'medium' },
      availableModels: [declaredNone],
      providerRouting: {
        ...routing,
        availability: {
          ...routing.availability,
          'claude-code': [{
            ...routing.availability['claude-code'][0]!,
            models: [declaredNone.id],
            effortMetaByModel: { [declaredNone.id]: { efforts: [], defaultEffort: null } },
          }],
        },
        resolveDefaultProviderIdForModel: () => 'custom-anthropic',
      },
      hasCindyAiApiKey: false,
    })).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS', message: expect.stringContaining('valid: none') });
  });

  it('keeps the legacy inherited route when no Agent/model change is requested', () => {
    expect(resolveSendToSessionExecutionConfig({
      source: fableSource(),
      overrides: { effort: 'high' },
      availableModels: available('claude-code'),
      providerRouting: providerRouting(),
      hasCindyAiApiKey: true,
    })).toMatchObject({
      ok: true,
      config: { providerId: 'anthropic', agentKind: 'claude-code' },
    });
  });

  it('returns the existing budget-model API-mode error before creation', () => {
    expect(resolveSendToSessionExecutionConfig({
      source: fableSource(),
      overrides: { agentKind: 'codex', model: 'codex/gpt-5.6-sol' },
      availableModels: [{
        id: 'codex/gpt-5.6-sol',
        efforts: ['xhigh'],
        defaultEffort: 'xhigh',
      }],
      providerRouting: {
        availability: {
          'claude-code': [],
          codex: [{
            id: 'xd',
            name: 'Cindy AI',
            models: ['codex/gpt-5.6-sol'],
            fastModels: [],
            effortMetaByModel: {
              'codex/gpt-5.6-sol': { efforts: ['xhigh'], defaultEffort: 'xhigh' },
            },
          }],
          pi: [],
        },
        resolveDefaultProviderIdForModel: () => 'xd',
      },
      hasCindyAiApiKey: false,
    })).toMatchObject({
      ok: false,
      errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
    });
  });

  it('uses the routed provider copy as the authority for effort and Fast capabilities', () => {
    expect(resolveSendToSessionExecutionConfig({
      source: fableSource(),
      overrides: {
        agentKind: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        fastMode: true,
      },
      // 模拟跨 provider 拍平表首见条目缺少 xhigh/Fast；实际默认路由支持。
      availableModels: [{
        id: 'gpt-5.6-sol',
        efforts: ['high'],
        defaultEffort: 'high',
        supportsFastMode: false,
      }],
      providerRouting: providerRouting(),
      hasCindyAiApiKey: true,
    })).toMatchObject({
      ok: true,
      config: { effort: 'xhigh', fastMode: true },
    });
  });

  it('fails before creation when no connected provider can route the selected model', () => {
    const routing = providerRouting();
    routing.availability.codex = [];
    expect(resolveSendToSessionExecutionConfig({
      source: fableSource(),
      overrides: { agentKind: 'codex', model: 'gpt-5.6-sol' },
      availableModels: available('codex'),
      providerRouting: routing,
      hasCindyAiApiKey: true,
    })).toMatchObject({
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
    });
  });
});
