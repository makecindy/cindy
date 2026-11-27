import type {
  ImDefaultBuiltinAgentKind,
  ImDefaultAgentSettings,
  ImDefaultPluginEngineSettings,
  ImDefaultSettingsPatch,
  ImDefaultSettingsState,
} from '../../../shared/imDefaultSettings';

export function buildAgentSettingsPatch(
  agentKind: ImDefaultBuiltinAgentKind,
  nextSettings: ImDefaultAgentSettings,
): ImDefaultSettingsPatch;
export function buildAgentSettingsPatch(
  agentKind: 'acp',
  nextSettings: ImDefaultPluginEngineSettings,
): ImDefaultSettingsPatch;
export function buildAgentSettingsPatch(
  agentKind: ImDefaultBuiltinAgentKind | 'acp',
  nextSettings: ImDefaultAgentSettings | ImDefaultPluginEngineSettings,
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
  const nextAgents = patch.agents ? { ...settings.agents, ...patch.agents } : settings.agents;
  if (nextAgents.acp && !nextAgents.acp.providerId && !nextAgents.acp.model) {
    const { acp: _cleared, ...rest } = nextAgents;
    return {
      ...settings,
      ...patch,
      agents: rest,
      isCustomized: true,
    };
  }
  return {
    ...settings,
    ...patch,
    agents: nextAgents,
    isCustomized: true,
  };
}
