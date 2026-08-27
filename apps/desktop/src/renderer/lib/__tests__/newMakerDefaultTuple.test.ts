import { describe, expect, it } from 'vitest';

import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';

import { resolveNewMakerDefaultTuple } from '@/lib/newMakerDefaultTuple';

function model(
  id: string,
  effort: CatalogModel['defaultEffort'] = 'high',
  newSessionDefault?: CatalogModel['newSessionDefault'],
): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: effort ? [effort] : [],
    defaultEffort: effort,
    newSessionDefault,
  };
}

function provider(args: {
  id: string;
  access: 'subscription' | 'managed';
  models: Partial<Record<AgentKind, CatalogModel[]>>;
  connected?: boolean;
  failed?: boolean;
}): ProviderView {
  const agents = Object.keys(args.models) as AgentKind[];
  return {
    id: args.id,
    name: args.id,
    source: 'builtin',
    agents,
    auth: { method: args.access === 'managed' ? 'managed' : 'oauth' },
    access:
      args.access === 'managed' ? { kind: 'managed' } : { kind: 'subscription', product: args.id },
    routing: {},
    models: args.models,
    connected: args.connected ?? true,
    ...(args.failed
      ? { modelDiscoveryFailure: { kind: 'upstream' as const, at: '2026-08-27T00:00:00Z' } }
      : {}),
  };
}

const allAgents = new Set(['cc', 'codex', 'pi'] as const);

function resolve(providers: ProviderView[], availableAgents = allAgents) {
  return resolveNewMakerDefaultTuple({
    providers,
    providersLoading: false,
    availableAgents,
    availableAgentsLoaded: true,
  });
}

describe('resolveNewMakerDefaultTuple', () => {
  it('没有来源或清单仍在加载时不编造默认组合', () => {
    expect(resolve([])).toBeNull();
    expect(
      resolveNewMakerDefaultTuple({
        providers: [],
        providersLoading: true,
        availableAgents: allAgents,
        availableAgentsLoaded: true,
      }),
    ).toBeNull();
  });

  it.each([
    {
      name: 'OpenAI 订阅',
      source: provider({
        id: 'openai',
        access: 'subscription',
        models: {
          codex: [{ ...model('chatgpt/gpt-5.6-sol', 'medium'), efforts: ['medium', 'high'] }],
        },
      }),
      expected: {
        vendor: 'codex',
        providerId: 'openai',
        model: 'chatgpt/gpt-5.6-sol',
        effort: 'high',
      },
    },
    {
      name: 'Anthropic 订阅',
      source: provider({
        id: 'anthropic',
        access: 'subscription',
        models: { 'claude-code': [model('claude-opus-5')] },
      }),
      expected: {
        vendor: 'cc',
        providerId: 'anthropic',
        model: 'claude-opus-5',
        effort: 'high',
      },
    },
    {
      name: 'xAI 订阅',
      source: provider({
        id: 'xai',
        access: 'subscription',
        models: { pi: [model('grok-4.6')] },
      }),
      expected: { vendor: 'pi', providerId: 'xai', model: 'grok-4.6', effort: 'high' },
    },
    {
      name: 'Cindy Gateway（CN / Global）',
      source: provider({
        id: 'xd',
        access: 'managed',
        models: { codex: [model('deepseek/deepseek-v4-pro', 'high', ['codex'])] },
      }),
      expected: {
        vendor: 'codex',
        providerId: 'xd',
        model: 'deepseek/deepseek-v4-pro',
        effort: 'high',
      },
    },
  ])('$name 得到完整推荐组合', ({ source, expected }) => {
    expect(resolve([source])).toEqual(expected);
  });

  it('订阅优先于 Gateway，多订阅无时间信息时按 OpenAI 稳定优先', () => {
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: { codex: [model('deepseek/deepseek-v4-pro', 'high', ['codex'])] },
    });
    const anthropic = provider({
      id: 'anthropic',
      access: 'subscription',
      models: { 'claude-code': [model('claude-opus-5')] },
    });
    const openai = provider({
      id: 'openai',
      access: 'subscription',
      models: { codex: [model('chatgpt/gpt-5.6-sol')] },
    });
    expect(resolve([gateway, anthropic, openai])).toMatchObject({
      vendor: 'codex',
      providerId: 'openai',
    });
  });

  it('首选 Harness 未安装时留在同一订阅来源并降级 Harness', () => {
    const xai = provider({
      id: 'xai',
      access: 'subscription',
      models: {
        pi: [model('grok-4.6')],
        codex: [model('xai/grok-4.6')],
      },
    });
    expect(resolve([xai], new Set(['cc', 'codex']))).toEqual({
      vendor: 'codex',
      providerId: 'xai',
      model: 'xai/grok-4.6',
      effort: 'high',
    });
  });

  it('发现失败的订阅不压过健康 Gateway', () => {
    const failedOpenai = provider({
      id: 'openai',
      access: 'subscription',
      models: { codex: [model('chatgpt/gpt-5.6-sol')] },
      failed: true,
    });
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: { codex: [model('deepseek/deepseek-v4-pro', 'high', ['codex'])] },
    });
    expect(resolve([failedOpenai, gateway])).toMatchObject({
      providerId: 'xd',
      vendor: 'codex',
    });
  });

  it('Gateway 没有服务端默认标记时保持空态', () => {
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: { codex: [model('deepseek/deepseek-v4-pro')] },
    });
    expect(resolve([gateway])).toBeNull();
  });
});
