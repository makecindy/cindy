import { describe, expect, it } from 'vitest';

import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';

import { resolveNewMakerDefaultTuple, isKnownProductDefaultTupleIdentity } from '@/lib/newMakerDefaultTuple';

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
    const candidate = { ...model('gpt-6.1-sol'), defaultEffort, efforts } as CatalogModel;
    expect(resolve([provider({ id: 'openai', access: 'subscription', models: { codex: [candidate] } })]))
      .toMatchObject({ model: 'gpt-6.1-sol', effort: expected });
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
          codex: [{ ...model('chatgpt/gpt-6.1-sol', 'medium'), efforts: ['medium', 'high'] }],
        },
      }),
      expected: {
        vendor: 'codex',
        providerId: 'openai',
        model: 'chatgpt/gpt-6.1-sol',
        effort: 'medium',
      },
    },
    {
      name: 'Anthropic 订阅',
      source: provider({
        id: 'anthropic',
        access: 'subscription',
        models: { 'claude-code': [model('claude-opus-5-5')] },
      }),
      expected: {
        vendor: 'cc',
        providerId: 'anthropic',
        model: 'claude-opus-5-5',
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
          pi: [model('auto', 'high', ['pi'], ['text', 'image'])],
        },
      }),
      expected: {
        vendor: 'pi',
        providerId: 'xd',
        model: 'auto',
        effort: 'high',
      },
    },
  ])('$name 得到完整推荐组合', ({ source, expected }) => {
    expect(resolve([source])).toEqual(expected);
  });

  it('Sol → Opus → Cindy Auto，与来源清单顺序无关', () => {
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: {
        pi: [model('auto', 'high', ['pi'], ['text', 'image'])],
      },
    });
    const anthropic = provider({
      id: 'anthropic',
      access: 'subscription',
      models: { 'claude-code': [model('claude-opus-5-5')] },
    });
    const openai = provider({
      id: 'openai',
      access: 'subscription',
      models: { codex: [model('chatgpt/gpt-6.1-sol')] },
    });
    for (const sources of [
      [gateway, anthropic, openai],
      [openai, anthropic, gateway],
    ]) {
      expect(resolve(sources)).toMatchObject({ vendor: 'codex', providerId: 'openai', model: 'chatgpt/gpt-6.1-sol' });
    }
    expect(resolve([anthropic, openai])).toMatchObject({ providerId: 'openai' });
    expect(resolve([gateway, anthropic])).toMatchObject({ providerId: 'anthropic' });
    expect(resolve([gateway, openai])).toMatchObject({ providerId: 'openai', vendor: 'codex' });
    expect(resolve([gateway])).toMatchObject({ providerId: 'xd', vendor: 'pi' });
    expect(resolve([anthropic, openai, gateway], new Set(['codex', 'pi']))).toMatchObject({ providerId: 'openai', vendor: 'codex' });
    expect(resolve([anthropic, openai, gateway], new Set(['pi']))).toMatchObject({ providerId: 'xd', vendor: 'pi' });
  });

  it('本机 xAI 订阅也不压过 Gateway 推荐组合', () => {
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: {
        pi: [model('auto', 'high', ['pi'], ['text', 'image'])],
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
      model: 'auto',
      effort: 'high',
    });
  });

  it.each([
    'disconnected',
    'suspended',
    'failed',
    'hidden',
    'no-pi',
  ] as const)('Gateway 不可用（%s）时排除该路由，保留订阅', (reason) => {
    const gatewayModel = model('auto', 'high', ['pi'], ['text', 'image']);
    const gateway = provider({ id: 'xd', access: 'managed', models: { pi: [gatewayModel] } });
    const openai = provider({
      id: 'openai',
      access: 'subscription',
      models: { codex: [model('gpt-6.1-sol')] },
    });
    if (reason === 'disconnected') gateway.connected = false;
    if (reason === 'suspended') gateway.suspended = true;
    if (reason === 'failed')
      gateway.modelDiscoveryFailure = { kind: 'upstream', at: '2026-09-05T00:00:00Z' };
    if (reason === 'hidden') gatewayModel.defaultEnabled = false;
    const agents = reason === 'no-pi' ? new Set(['cc', 'codex'] as const) : allAgents;
    expect(resolve([gateway], agents)).toBeNull();
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

  it('does not put Opus or Sol on another harness when their native harness is absent', () => {
    const anthropic = provider({ id: 'anthropic', access: 'subscription', models: {
      'claude-code': [model('claude-opus-5-5')], pi: [model('claude-opus-5-5')], codex: [model('claude-opus-5-5')],
    } });
    const openai = provider({ id: 'openai', access: 'subscription', models: {
      codex: [model('gpt-6.1-sol')], pi: [model('gpt-6.1-sol')], 'claude-code': [model('gpt-6.1-sol')],
    } });
    expect(resolve([anthropic], new Set(['codex', 'pi']))).toBeNull();
    expect(resolve([openai], new Set(['cc', 'pi']))).toBeNull();
  });

  it('发现失败的订阅不压过健康 Gateway', () => {
    const failedOpenai = provider({
      id: 'openai',
      access: 'subscription',
      models: { codex: [model('chatgpt/gpt-6.1-sol')] },
      failed: true,
    });
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: {
        pi: [model('auto', 'high', ['pi'], ['text', 'image'])],
      },
    });
    expect(resolve([failedOpenai, gateway])).toMatchObject({
      providerId: 'xd',
      vendor: 'pi',
    });
  });

  it('Cindy Auto 不依赖旧 GLM 的默认标记', () => {
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: {
        pi: [model('auto', 'high', undefined, ['text', 'image'])],
      },
    });
    expect(resolve([gateway])).toMatchObject({ providerId: 'xd', model: 'auto', vendor: 'pi' });
  });

  it('Cindy Auto 没有 Pi 路由时不伪造 Pi 候选', () => {
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: {
        codex: [model('auto', 'high', ['codex'], ['text', 'image'])],
      },
    });
    expect(resolve([gateway])).toBeNull();
  });

  it('Cindy Auto 沿用实际下发的输入能力，不靠图片字段决定默认身份', () => {
    const gateway = provider({
      id: 'xd',
      access: 'managed',
      models: { pi: [model('auto', 'high', ['pi'], ['text'])] },
    });
    expect(resolve([gateway])).toMatchObject({ providerId: 'xd', model: 'auto', vendor: 'pi' });
  });

  it('新任务沿用模型声明的默认深度，不另写 high', () => {
    const openai = provider({
      id: 'openai',
      access: 'subscription',
      models: { codex: [model('chatgpt/gpt-6.1-sol', 'medium')] },
    });
    expect(resolve([openai])).toMatchObject({ effort: 'medium' });
  });

  it.each([false, true])('searches independent accounts before model fallback (visibility callback: %s)', withVisibility => {
    const stale = provider({ id: 'openai', access: 'subscription', models: { codex: [model('gpt-6-sol')] } });
    const account = provider({ id: 'openai-account', access: 'subscription', models: { codex: [model('gpt-6.1-sol')] } });
    account.auth = { method: 'oauth', native: 'codex' };
    const args = { providers: [stale, account], providersLoading: false, availableAgents: allAgents,
      availableAgentsLoaded: true, ...(withVisibility ? { isModelEnabled: () => true } : {}) };
    expect(resolveNewMakerDefaultTuple(args)).toMatchObject({ providerId: account.id, model: 'gpt-6.1-sol' });
    if (withVisibility) {
      // Once no account has a visible Sol, retain the enabled model fallback.
      expect(resolveNewMakerDefaultTuple({ ...args, isModelEnabled: (_agent, _providerId, m) => m.id !== 'gpt-6.1-sol' }))
        .toMatchObject({ providerId: stale.id, model: 'gpt-6-sol' });
    }
    const claude = provider({ id: 'claude-account', access: 'subscription', models: { 'claude-code': [model('claude-opus-5-5')] } });
    claude.auth = { method: 'oauth', native: 'claude' };
    expect(resolve([claude])).toMatchObject({ providerId: claude.id, vendor: 'cc' });
  });

  it('does not replace missing or disabled Auto with a hardcoded gateway model', () => {
    const glm = model('z-ai/glm-5.3-flash', 'high', ['pi'], ['text', 'image']);
    const gateway = provider({ id: 'xd', access: 'managed', models: { pi: [glm] } });
    const args = { providers: [gateway], providersLoading: false, availableAgents: allAgents,
      availableAgentsLoaded: true, isModelEnabled: (_agent: AgentKind, _id: string, m: { id: string }) => m.id !== 'auto' };
    expect(resolveNewMakerDefaultTuple(args)).toBeNull();
    expect(resolve([gateway])).toBeNull();
    gateway.models.pi!.push(model('auto'));
    expect(resolveNewMakerDefaultTuple(args)).toBeNull();
    expect(resolveNewMakerDefaultTuple({ ...args, isModelEnabled: () => true }))
      .toMatchObject({ providerId: 'xd', model: 'auto' });
  });

  it('recognizes earlier automatic tuples without declaring them current defaults', () => {
    for (const modelId of ['gpt-6-sol', 'chatgpt/gpt-6-sol']) {
      expect(isKnownProductDefaultTupleIdentity({ vendor: 'codex', providerId: 'openai', model: modelId })).toBe(true);
    }
    expect(isKnownProductDefaultTupleIdentity({ vendor: 'codex', providerId: 'openai', model: 'gpt-6-astra' })).toBe(true);
    expect(isKnownProductDefaultTupleIdentity({ vendor: 'pi', providerId: 'xd', model: 'z-ai/glm-5.3-flash' })).toBe(true);
    expect(isKnownProductDefaultTupleIdentity({ vendor: 'pi', providerId: 'xd', model: 'auto' })).toBe(true);
  });
});
