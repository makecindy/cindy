import type { AgentKind } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import type { OrcaWorkerProviderRoutingContext } from '../orcaWorkerCreationService';
import {
  resolveSendToSessionCreateRoute,
  resolveSendToSessionExecutionConfig,
  type SendToSessionRoutingSnapshot,
} from '../sendToSessionExecutionConfig';

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

  // Unit regression: flattened model metadata may belong to a different account.
  // Existing Fast/effort coverage did not exercise Ultrafast or inherited speed.
  it.each([true, false])('uses the selected account Ultrafast entitlement (%s)', (entitled) => {
    const model = 'gpt-5.6-sol';
    const routing = providerRouting();
    const primary = routing.availability.codex[0];
    routing.availability.codex = [
      { ...primary, ultrafastModels: entitled ? [] : [model] },
      { ...primary, id: 'selected-account', ultrafastModels: entitled ? [model] : [] },
    ];
    routing.resolveDefaultProviderIdForModel = () => 'selected-account';
    for (const routeChanged of [false, true]) {
      const source = routeChanged
        ? { ...fableSource(), fastMode: 'ultrafast' as const }
        : { ...sourceFor('codex'), providerId: 'selected-account', fastMode: 'ultrafast' as const };
      const base = {
        source, availableModels: [{ ...available('codex')[0], supportsUltrafastMode: !entitled }],
        providerRouting: routing, hasCindyAiApiKey: true,
      };
      const routeOverrides = routeChanged ? { agentKind: 'codex' as const, model } : {};
      expect(resolveSendToSessionExecutionConfig({
        ...base, overrides: { ...routeOverrides, fastMode: 'ultrafast' },
      })).toMatchObject(entitled
        ? { ok: true, config: { fastMode: 'ultrafast' } }
        : { ok: false, errorCode: 'INVALID_ARGS' });
      expect(resolveSendToSessionExecutionConfig({
        ...base, overrides: routeOverrides,
      })).toMatchObject({ ok: true, config: { fastMode: entitled ? 'ultrafast' : false } });
    }
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

// #9195: send_to_session create 的 agent_device_id。生产入口是 register.ts create 分支调用的
// resolveSendToSessionCreateRoute；它的结果直接决定 openSession 的 agentDeviceId 与模型来源，
// 失败结果让 create 分支在建任务前返回。
describe('resolveSendToSessionCreateRoute', () => {
  const SELF = 'self-device';
  // 另一台电脑：同一个模型由那台的订阅提供，来源需要显式写入。
  const deviceSnapshot = (models: string[] = ['claude-fable-5']): SendToSessionRoutingSnapshot => ({
    availableModels: available('claude-code').filter((model) => models.includes(model.id)),
    providerRouting: {
      availability: {
        'claude-code': [{
          id: 'device-b-anthropic',
          name: 'Anthropic (device-b)',
          models,
          requiresExplicitRoute: true,
          effortMetaByModel: Object.fromEntries(models.map((id) => [id, { efforts: ['high'], defaultEffort: 'high' }])),
        }],
        codex: [],
        pi: [],
      },
      resolveDefaultProviderIdForModel: () => 'device-b-anthropic',
    },
    hasCindyAiApiKey: true,
  });
  const routingDeps = (device: () => Promise<SendToSessionRoutingSnapshot> = async () => deviceSnapshot()) => ({
    isSelfDeviceId: (deviceId: string) => deviceId === SELF,
    readLocalRouting: vi.fn(async (agentKind: AgentKind): Promise<SendToSessionRoutingSnapshot> => ({
      availableModels: available(agentKind),
      providerRouting: providerRouting(),
      hasCindyAiApiKey: true,
    })),
    readDeviceRouting: vi.fn((_deviceId: string, _agentKind: AgentKind) => device()),
  });

  it('SC1: 指定另一台电脑 → 位置为那台，沿用来源模型 id，来源按那台的供应商解析', async () => {
    const deps = routingDeps();
    const result = await resolveSendToSessionCreateRoute({
      source: fableSource(), sourceAgentDeviceId: null, sourceIsSsh: false, requestedAgentDeviceId: 'device-b',
    }, deps);
    expect(result).toEqual({
      ok: true,
      agentDeviceId: 'device-b',
      config: { agentKind: 'claude-code', model: 'claude-fable-5', effort: 'high', fastMode: false, providerId: 'device-b-anthropic' },
    });
    expect(deps.readDeviceRouting).toHaveBeenCalledWith('device-b', 'claude-code');
    expect(deps.readLocalRouting).not.toHaveBeenCalled();
  });

  it.each([
    { name: '来源在本机', sourceAgentDeviceId: null },
    { name: '来源在另一台电脑', sourceAgentDeviceId: 'device-a' },
  ])('SC2: 不指定位置 → 继承来源位置与配置，不读任何供应商 ($name)', async ({ sourceAgentDeviceId }) => {
    const deps = routingDeps();
    const result = await resolveSendToSessionCreateRoute({
      source: fableSource(), sourceAgentDeviceId, sourceIsSsh: false,
    }, deps);
    expect(result).toEqual({ ok: true, agentDeviceId: sourceAgentDeviceId, config: fableSource() });
    expect(deps.readDeviceRouting).not.toHaveBeenCalled();
    expect(deps.readLocalRouting).not.toHaveBeenCalled();
  });

  it.each([
    { requested: null, label: '"local"' },
    { requested: SELF, label: '本机设备 id' },
  ])('SC3: $label → 新任务在本机；来源在另一台时按本机供应商重新解析', async ({ requested }) => {
    const deps = routingDeps();
    const fromRemote = await resolveSendToSessionCreateRoute({
      source: { ...fableSource(), providerId: 'device-a-sub' },
      sourceAgentDeviceId: 'device-a', sourceIsSsh: false, requestedAgentDeviceId: requested,
    }, deps);
    expect(fromRemote).toMatchObject({ ok: true, agentDeviceId: null, config: { model: 'claude-fable-5', providerId: null } });
    expect(deps.readLocalRouting).toHaveBeenCalledWith('claude-code');
    expect(deps.readDeviceRouting).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: '格式不对',
      params: { sourceIsSsh: false, requestedAgentDeviceId: 'bad id!' },
      device: async () => deviceSnapshot(),
      errorCode: 'INVALID_ARGS',
    },
    {
      name: 'SSH 来源指定位置',
      params: { sourceIsSsh: true, requestedAgentDeviceId: 'device-b' },
      device: async () => deviceSnapshot(),
      errorCode: 'INVALID_ARGS',
    },
    {
      // "local" 到宿主是 null；SSH 来源的 Agent 在 SSH 主机上，显式本机位置同样要拒绝，
      // 否则位置被当成未变、沿用 SSH 来源的模型与供应商在本机建任务。
      name: 'SSH 来源显式 "local"',
      params: { sourceIsSsh: true, requestedAgentDeviceId: null },
      device: async () => deviceSnapshot(),
      errorCode: 'INVALID_ARGS',
    },
    {
      name: 'SSH 来源显式本机设备 id',
      params: { sourceIsSsh: true, requestedAgentDeviceId: SELF },
      device: async () => deviceSnapshot(),
      errorCode: 'INVALID_ARGS',
    },
    {
      name: '那台没有来源模型',
      params: { sourceIsSsh: false, requestedAgentDeviceId: 'device-b' },
      device: async () => deviceSnapshot(['claude-opus-fast']),
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
    },
    {
      name: '那台读不到供应商',
      params: { sourceIsSsh: false, requestedAgentDeviceId: 'device-b' },
      device: async (): Promise<SendToSessionRoutingSnapshot> => { throw new Error('device offline'); },
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
    },
  ])('SC4: $name → $errorCode，不换模型也不建任务', async ({ params, device, errorCode }) => {
    const result = await resolveSendToSessionCreateRoute({
      source: fableSource(), sourceAgentDeviceId: null, ...params,
    }, routingDeps(device));
    expect(result).toMatchObject({ ok: false, errorCode });
  });

  it('继承来的位置读不到供应商时保持原有失败方式(抛给 create 分支)，不改成换电脑的失败码', async () => {
    const deps = routingDeps(async () => { throw new Error('device offline'); });
    await expect(resolveSendToSessionCreateRoute({
      source: fableSource(), sourceAgentDeviceId: 'device-a', sourceIsSsh: false,
      overrides: { effort: 'high' },
    }, deps)).rejects.toThrow('device offline');
  });
});
