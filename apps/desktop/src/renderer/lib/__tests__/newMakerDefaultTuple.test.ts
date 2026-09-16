import { describe, expect, it } from 'vitest';

import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';

import { resolveNewMakerDefaultTuple, resolveNewMakerDefaultTuples } from '@/lib/newMakerDefaultTuple';

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
    ...(args.access === 'subscription' ? { newSessionDefaults: {
      openai: { codex: 'gpt-5.6-sol', 'claude-code': 'gpt-5.6-sol', pi: 'gpt-5.6-sol' },
      anthropic: { codex: 'claude-opus-5', 'claude-code': 'claude-opus-5', pi: 'claude-opus-5' },
      xai: { codex: 'grok-4.6', 'claude-code': 'grok-4.6', pi: 'grok-4.6' },
    }[args.id] } : {}),
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
  it('uses configured subscription models for every Harness without changing Harness preference', () => {
    const source = provider({ id: 'openai', access: 'subscription', models: {
      codex: [model('gpt-5.6-sol'), model('configured-codex')],
      'claude-code': [model('chatgpt/configured-claude')], pi: [model('chatgpt/configured-pi')],
    } });
    source.newSessionDefaults = { codex: 'configured-codex', 'claude-code': 'configured-claude', pi: 'configured-pi' };
    expect(resolve([source])).toMatchObject({ vendor: 'codex', model: 'configured-codex' });
    expect(resolve([source], new Set(['cc', 'pi']))).toMatchObject({ vendor: 'cc', model: 'chatgpt/configured-claude' });
    expect(resolve([source], new Set(['pi']))).toMatchObject({ vendor: 'pi', model: 'chatgpt/configured-pi' });
    source.newSessionDefaults = {};
    expect(resolve([source])).toBeNull();
    delete source.newSessionDefaults;
    expect(resolve([source])).toBeNull();
    expect(resolveNewMakerDefaultTuple({ providers: [source], providersLoading: false,
      availableAgents: allAgents, availableAgentsLoaded: true, isModelEnabled: () => true })).toBeNull();
  });
  it.each([
    { defaultEnabled: false }, { disabled: true }, { status: 'retired' as const },
  ])('does not recommend an unavailable configured subscription model: %j', flags => {
    const source = provider({ id: 'xai', access: 'subscription', models: { pi: [{ ...model('configured'), ...flags }, model('grok-4.6')] } });
    source.newSessionDefaults = { pi: 'configured' };
    expect(resolve([source])).toBeNull();
  });
  it('does not fabricate missing configured models or change another subscription', () => {
    const first = provider({ id: 'openai', access: 'subscription', models: { codex: [model('gpt-5.6-sol')] } });
    first.newSessionDefaults = { pi: 'missing' };
    const second = provider({ id: 'xai', access: 'subscription', models: { pi: [model('grok-4.6')] } });
    expect(resolve([first, second])).toMatchObject({ providerId: 'xai', vendor: 'pi', model: 'grok-4.6' });
  });
  it('accepts explicitly configured subscriptions outside the legacy hardcoded list', () => {
    const source = provider({ id: 'other-subscription', access: 'subscription', models: { pi: [model('configured')] } });
    source.newSessionDefaults = { pi: 'configured' };
    expect(resolve([source])).toMatchObject({ providerId: 'other-subscription', vendor: 'pi', model: 'configured' });
    delete source.newSessionDefaults;
    expect(resolve([source])).toBeNull();
  });
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

  it('uses a newly published Gateway recommendation without a client model-ID change', () => {
    const oldModel = model('z-ai/glm-5.3-flash', 'high', undefined, ['text', 'image']);
    const nextModel = model('new-gateway-model', 'medium', ['pi'], ['text', 'image']);
    const gateway = provider({ id: 'xd', access: 'managed', models: { pi: [oldModel, nextModel] } });
    expect(resolve([gateway])).toMatchObject({ vendor: 'pi', model: 'new-gateway-model', effort: 'medium' });
    nextModel.newSessionDefault = undefined;
    expect(resolve([gateway])).toBeNull();
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

it.each([false, true])('orders independent subscriptions by catalog brand while keeping their account IDs (%s)', reverse => {
  const disconnected = provider({ id: 'openai', access: 'subscription', connected: false, models: { codex: [model('gpt-5.6-sol')] } });
  const openai = { ...provider({ id: 'openai-account', access: 'subscription', models: { codex: [model('configured-openai')] } }),
    auth: { method: 'oauth' as const, native: 'codex' as const }, newSessionDefaults: { codex: 'configured-openai' } };
  const anthropic = provider({ id: 'anthropic', access: 'subscription', models: { 'claude-code': [model('claude-opus-5')] } });
  const xai = { ...provider({ id: 'xai-account', access: 'subscription', models: { pi: [model('configured-xai')] } }),
    auth: { method: 'oauth' as const, native: 'xai' as const }, newSessionDefaults: { pi: 'configured-xai' } };
  const unknown = { ...provider({ id: 'another-subscription', access: 'subscription', models: { pi: [model('configured-other')] } }),
    newSessionDefaults: { pi: 'configured-other' } };
  const gateway = provider({ id: 'xd', access: 'managed', models: { pi: [model('configured-gateway', 'high', ['pi'], ['text', 'image'])] } });
  const sources = [unknown, xai, anthropic, disconnected, openai];
  if (reverse) sources.reverse();
  expect(resolve(sources)).toMatchObject({ providerId: 'openai-account', vendor: 'codex', model: 'configured-openai' });
  expect(resolveNewMakerDefaultTuples({ providers: [...sources, gateway], providersLoading: false,
    availableAgents: allAgents, availableAgentsLoaded: true }).map(tuple => tuple.providerId))
    .toEqual(['xd', 'openai-account', 'anthropic', 'xai-account', 'another-subscription']);
  openai.connected = false;
  expect(resolve(sources)).toMatchObject({ providerId: 'anthropic' });
});
