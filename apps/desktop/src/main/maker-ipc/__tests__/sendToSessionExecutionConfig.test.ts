import type { AgentKind } from '@cindy/maker-core';
import { describe, expect, it } from 'vitest';

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
    : [
        {
          id: 'claude-fable-5',
          efforts: ['high'],
          defaultEffort: 'high',
          supportsFastMode: false,
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

const providerRouting = (defaults: Partial<Record<AgentKind, string>> = {}) => ({
  availability: {
    'claude-code': [{
      id: 'anthropic',
      name: 'Anthropic',
      models: ['claude-fable-5'],
      fastModels: [],
      effortMetaByModel: {
        'claude-fable-5': { efforts: ['high'], defaultEffort: 'high' },
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
    pi: [],
  },
  resolveDefaultProviderIdForModel: (agent: AgentKind) => defaults[agent] ?? (
    agent === 'claude-code' ? 'anthropic' : agent === 'codex' ? 'openai' : null
  ),
});

describe('resolveSendToSessionExecutionConfig', () => {
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
