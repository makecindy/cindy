import { describe, expect, it } from 'vitest';

import {
  buildAgentSettingsPatch,
  mergeSettingsPatch,
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
