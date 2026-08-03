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

  it('已存模型不在可用清单里 → 换成清单首个, 供应商重解, 强度按新模型能力回落', () => {
    expect(
      resolveAgentSwitchSettings({
        current: { ...current },
        available: [{ id: 'live-model', efforts: ['low', 'medium'] }],
        fallbackEffort: 'medium',
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
        fallbackEffort: 'low',
        resolveProviderId: (modelId, providerId) => (providerId === 'openai' ? 'openai' : modelId),
      }),
    ).toEqual({ model: 'live-model', providerId: 'openai', effort: 'high' });
  });

  it('fallbackEffort 也不被新模型支持 → 取该模型的首个强度', () => {
    expect(
      resolveAgentSwitchSettings({
        current: { ...current },
        available: [{ id: 'live-model', efforts: ['xhigh'] }],
        fallbackEffort: 'medium',
        resolveProviderId,
      }).effort,
    ).toBe('xhigh');
  });

  it('该 agent 当下一个可用模型都没有 → 原样保留, 不抹成空值', () => {
    const kept = { ...current };
    expect(
      resolveAgentSwitchSettings({
        current: kept,
        available: [],
        fallbackEffort: 'medium',
        resolveProviderId,
      }),
    ).toEqual(kept);
  });
});
