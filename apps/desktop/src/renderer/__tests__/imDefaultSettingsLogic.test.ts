import { describe, expect, it } from 'vitest';

import {
  buildAgentSettingsPatch,
  mergeSettingsPatch,
  resolveAgentSwitchSettings,
} from '@/components/settings/imDefaultSettingsLogic';
import {
  IM_DEFAULT_SETTINGS,
  type ImDefaultSettingsState,
} from '../../shared/imDefaultSettings';

describe('im default settings logic', () => {
  it('patches only the changed agent slot', () => {
    expect(buildAgentSettingsPatch('codex', {
      providerId: 'openai',
      model: 'gpt-5.5',
      effort: 'high',
    })).toEqual({
      agents: {
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });
  });

  it('merges partial agent patches for optimistic state without dropping the other slot', () => {
    const state: ImDefaultSettingsState = {
      ...IM_DEFAULT_SETTINGS,
      defaults: IM_DEFAULT_SETTINGS,
      isCustomized: false,
      customizedKeys: [],
    };

    expect(mergeSettingsPatch(state, {
      agents: {
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    }).agents).toEqual({
      'claude-code': IM_DEFAULT_SETTINGS.agents['claude-code'],
      codex: {
        providerId: 'openai',
        model: 'gpt-5.5',
        effort: 'high',
      },
      pi: IM_DEFAULT_SETTINGS.agents.pi,
    });
  });
});

describe('resolveAgentSwitchSettings (切 harness 时收敛目标 agent 的模型/供应商/强度)', () => {
  const current = { providerId: 'stale-provider', model: 'retired-model', effort: 'high' } as const;
  const resolveProviderId = (modelId: string, providerId: string | null): string | null =>
    providerId ?? `provider-of-${modelId}`;
  /**
   * 组件里 resolveEffort 的等价实现(顺序照 ImDefaultSettingsSection):
   * 当前值 → 该模型的 override → 该模型的 defaultEffort → 该模型首档 → agent 出厂值。
   * 传它进去正是为了锁住「切 agent 与切模型对同一模型给出同一强度」。
   */
  const makeResolveEffort =
    (
      catalog: Record<
        string,
        { efforts: readonly string[]; defaultEffort?: string; override?: string }
      >,
      agentFallback: string,
    ) =>
    (modelId: string, requested: string): 'low' | 'medium' | 'high' | 'xhigh' => {
      const model = catalog[modelId];
      if (!model || model.efforts.length === 0) return requested as 'high';
      if (model.efforts.includes(requested)) return requested as 'high';
      if (model.override && model.efforts.includes(model.override)) return model.override as 'high';
      if (model.defaultEffort && model.efforts.includes(model.defaultEffort)) {
        return model.defaultEffort as 'high';
      }
      if (model.efforts.includes(agentFallback)) return agentFallback as 'high';
      return model.efforts[0] as 'high';
    };

  it('已存模型不在可用清单里 → 换成清单首个, 供应商重解, 强度按新模型能力回落', () => {
    expect(
      resolveAgentSwitchSettings({
        current: { ...current },
        available: [{ id: 'live-model', efforts: ['low', 'medium'] }],
        resolveEffort: makeResolveEffort({ 'live-model': { efforts: ['low', 'medium'] } }, 'medium'),
        resolveProviderId,
      }),
    ).toEqual({
      model: 'live-model',
      providerId: 'provider-of-live-model',
      effort: 'medium',
    });
  });

  it('已存模型仍可用 → 保留模型与强度, 但仍重解供应商(旧 providerId 可能已断开)', () => {
    expect(
      resolveAgentSwitchSettings({
        current: { providerId: 'openai', model: 'live-model', effort: 'high' },
        available: [{ id: 'live-model', efforts: ['high', 'low'] }],
        resolveEffort: makeResolveEffort({ 'live-model': { efforts: ['high', 'low'] } }, 'low'),
        resolveProviderId: (modelId, providerId) => (providerId === 'openai' ? 'openai' : modelId),
      }),
    ).toEqual({ model: 'live-model', providerId: 'openai', effort: 'high' });
  });

  it('agent 出厂强度也不被新模型支持 → 取该模型的首个强度', () => {
    expect(
      resolveAgentSwitchSettings({
        current: { ...current },
        available: [{ id: 'live-model', efforts: ['xhigh'] }],
        resolveEffort: makeResolveEffort({ 'live-model': { efforts: ['xhigh'] } }, 'medium'),
        resolveProviderId,
      }).effort,
    ).toBe('xhigh');
  });

  it('强度回落必须先用该模型自己的 defaultEffort, 而不是先跳到 agent 出厂值', () => {
    // 新模型支持 low/medium/xhigh: 当前 high 不支持 → 该模型 defaultEffort=xhigh 优先,
    // 不能因为 agent 出厂值 medium 也在清单里就先用它(review 指出的顺序错位)。
    expect(
      resolveAgentSwitchSettings({
        current: { ...current },
        available: [{ id: 'live-model', efforts: ['low', 'medium', 'xhigh'] }],
        resolveEffort: makeResolveEffort(
          { 'live-model': { efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'xhigh' } },
          'medium',
        ),
        resolveProviderId,
      }).effort,
    ).toBe('xhigh');
  });

  it('模型级 override 优先于该模型的 defaultEffort 与 agent 出厂值', () => {
    expect(
      resolveAgentSwitchSettings({
        current: { ...current },
        available: [{ id: 'live-model', efforts: ['low', 'medium', 'xhigh'] }],
        resolveEffort: makeResolveEffort(
          {
            'live-model': {
              efforts: ['low', 'medium', 'xhigh'],
              defaultEffort: 'xhigh',
              override: 'low',
            },
          },
          'medium',
        ),
        resolveProviderId,
      }).effort,
    ).toBe('low');
  });

  it('该 agent 当下一个可用模型都没有 → 原样保留, 不抹成空值', () => {
    const kept = { ...current };
    expect(
      resolveAgentSwitchSettings({
        current: kept,
        available: [],
        resolveEffort: makeResolveEffort({}, 'medium'),
        resolveProviderId,
      }),
    ).toEqual(kept);
  });
});
