import type {
  ImDefaultAgentKind,
  ImDefaultAgentSettings,
  ImDefaultSettingsPatch,
  ImDefaultSettingsState,
} from '../../../shared/imDefaultSettings';

export function buildAgentSettingsPatch(
  agentKind: ImDefaultAgentKind,
  nextSettings: ImDefaultAgentSettings,
): ImDefaultSettingsPatch {
  return {
    agents: {
      [agentKind]: nextSettings,
    },
  };
}

export function mergeSettingsPatch(
  settings: ImDefaultSettingsState,
  patch: ImDefaultSettingsPatch,
): ImDefaultSettingsState {
  return {
    ...settings,
    ...patch,
    agents: patch.agents ? { ...settings.agents, ...patch.agents } : settings.agents,
    isCustomized: true,
  };
}
