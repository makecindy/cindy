import { describe, expect, it } from 'vitest';

import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';

import { resolveNewMakerDefaultTuple } from '@/lib/newMakerDefaultTuple';

function model(
  id: string,
  effort: CatalogModel['defaultEffort'] = 'high',
  newSessionDefault?: CatalogModel['newSessionDefault'],
  inputModalities?: string[],
): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: effort ? [effort] : [],
    defaultEffort: effort,
    newSessionDefault,
    ...(inputModalities ? { modalities: { input: inputModalities, output: ['text'] } } : {}),
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
  it.each([
    { defaultEffort: undefined, efforts: ['low', 'medium', 'high'], expected: 'medium' },
    { defaultEffort: 'max', efforts: ['low', 'medium', 'high'], expected: 'high' },
    { defaultEffort: undefined, efforts: [], expected: null },
  ])('keeps a usable model with incomplete or stale effort metadata: %j', ({ defaultEffort, efforts, expected }) => {
    const candidate = { ...model('gpt-5.6-sol'), defaultEffort, efforts } as CatalogModel;
    expect(resolve([provider({ id: 'openai', access: 'subscription', models: { codex: [candidate] } })]))
      .toMatchObject({ model: 'gpt-5.6-sol', effort: expected });
  });

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
        effort: 'medium',
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
        models: {
          pi: [model('z-ai/glm-5.3-flash', 'high', ['pi'], ['text', 'image'])],
        },
      }),
      expected: {
        vendor: 'pi',
        providerId: 'xd',
        model: 'z-ai/glm-5.3-flash',
        effort: 'high',
      },
    },
  ])('$name 得到完整推荐组合', ({ source, expected }) => {
    expect(resolve([source])).toEqual(expected);
  });

  it('Gateway 优先于全部订阅，与来源清单顺序无关', () => {
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: {
        pi: [model('z-ai/glm-5.3-flash', 'high', ['pi'], ['text', 'image'])],
      },
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
    for (const sources of [
      [gateway, anthropic, openai],
      [openai, anthropic, gateway],
    ]) {
      expect(resolve(sources)).toMatchObject({ vendor: 'pi', providerId: 'xd' });
    }
    // 无 Gateway 时保留订阅之间的稳定回退顺序。
    expect(resolve([anthropic, openai])).toMatchObject({ providerId: 'openai' });
  });

  it('本机 xAI 订阅也不压过 Gateway 推荐组合', () => {
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: {
        pi: [model('z-ai/glm-5.3-flash', 'high', ['pi'], ['text', 'image'])],
      },
    });
    const xai = provider({
      id: 'xai',
      access: 'subscription',
      models: { pi: [model('grok-4.6')] },
    });
    expect(resolve([gateway, xai])).toEqual({
      vendor: 'pi',
      providerId: 'xd',
      model: 'z-ai/glm-5.3-flash',
      effort: 'high',
    });
  });

  it.each([
    'disconnected',
    'suspended',
    'failed',
    'hidden',
    'unmarked',
    'no-image',
    'no-pi',
  ] as const)('Gateway 不可用（%s）时回退订阅', (reason) => {
    const gatewayModel = model('z-ai/glm-5.3-flash', 'high', ['pi'], ['text', 'image']);
    const gateway = provider({ id: 'xd', access: 'managed', models: { pi: [gatewayModel] } });
    const openai = provider({
      id: 'openai',
      access: 'subscription',
      models: { codex: [model('gpt-5.6-sol')] },
    });
    if (reason === 'disconnected') gateway.connected = false;
    if (reason === 'suspended') gateway.suspended = true;
    if (reason === 'failed')
      gateway.modelDiscoveryFailure = { kind: 'upstream', at: '2026-09-05T00:00:00Z' };
    if (reason === 'hidden') gatewayModel.defaultEnabled = false;
    if (reason === 'unmarked') gatewayModel.newSessionDefault = undefined;
    if (reason === 'no-image') gatewayModel.modalities = { input: ['text'], output: ['text'] };
    const agents = reason === 'no-pi' ? new Set(['cc', 'codex'] as const) : allAgents;
    expect(resolve([gateway, openai], agents)).toMatchObject({
      providerId: 'openai',
      vendor: 'codex',
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
      models: {
        pi: [model('z-ai/glm-5.3-flash', 'high', ['pi'], ['text', 'image'])],
      },
    });
    expect(resolve([failedOpenai, gateway])).toMatchObject({
      providerId: 'xd',
      vendor: 'pi',
    });
  });

  it('Gateway 没有服务端默认标记时保持空态', () => {
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: {
        pi: [model('z-ai/glm-5.3-flash', 'high', undefined, ['text', 'image'])],
      },
    });
    expect(resolve([gateway])).toBeNull();
  });

  it('Gateway 只有旧 Codex 标记时不把 GLM 默认塞进其它 Harness', () => {
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: {
        codex: [model('z-ai/glm-5.3-flash', 'high', ['codex'], ['text', 'image'])],
      },
    });
    expect(resolve([gateway])).toBeNull();
  });

  it('Gateway 默认标记误落到纯文本模型时保持空态', () => {
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: { pi: [model('z-ai/glm-5.3-flash', 'high', ['pi'], ['text'])] },
    });
    expect(resolve([gateway])).toBeNull();
  });

  it('新任务沿用模型声明的默认深度，不另写 high', () => {
    const openai = provider({
      id: 'openai',
      access: 'subscription',
      models: { codex: [model('chatgpt/gpt-5.6-sol', 'medium')] },
    });
    expect(resolve([openai])).toMatchObject({ effort: 'medium' });
  });
});
