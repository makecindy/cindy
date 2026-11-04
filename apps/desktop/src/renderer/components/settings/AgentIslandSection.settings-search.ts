import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { AGENT_ISLAND_MASCOT_SKINS } from '../../../shared/agentIsland';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const agentIslandSettings = defineSettings({
  agentIsland: {
    id: 'agentIsland',
    tab: 'agent-island',
    targetId: 'settings-panel-agent-island',
    titleKey: TAB_LABEL_KEY['agent-island'],
    sectionKey: 'settings.sections.agentIsland',
  },
  enableLabel: {
    id: 'settings.agentIsland.enableLabel',
    fallbackTargetId: 'settings-panel-agent-island',
    tab: 'agent-island',
    targetId: 'settings-search-settings-agentIsland-enableLabel',
    titleKey: 'settings.agentIsland.enableLabel',
    sectionKey: 'settings.tabs.agentIsland',
    descriptionKey: 'settings.agentIsland.enableHint',
  },
  displayLabel: {
    id: 'settings.agentIsland.displayLabel',
    fallbackTargetId: 'settings-panel-agent-island',
    tab: 'agent-island',
    targetId: 'settings-search-settings-agentIsland-displayLabel',
    titleKey: 'settings.agentIsland.displayLabel',
    sectionKey: 'settings.tabs.agentIsland',
    descriptionKey: 'settings.agentIsland.displayHint',
  },
  skinLabel: {
    id: 'settings.agentIsland.skinLabel',
    fallbackTargetId: 'settings-panel-agent-island',
    tab: 'agent-island',
    targetId: 'settings-search-settings-agentIsland-skinLabel',
    titleKey: 'settings.agentIsland.skinLabel',
    sectionKey: 'settings.tabs.agentIsland',
    descriptionKey: 'settings.agentIsland.skinHint',
    options: AGENT_ISLAND_MASCOT_SKINS.map((skin) => ({
      value: skin,
      labelKey: `settings.agentIsland.skins.${skin}.name`,
      descriptionKey: `settings.agentIsland.skins.${skin}.description`,
    })),
  },
  soundLabel: {
    id: 'settings.agentIsland.soundLabel',
    fallbackTargetId: 'settings-panel-agent-island',
    tab: 'agent-island',
    targetId: 'settings-search-settings-agentIsland-soundLabel',
    titleKey: 'settings.agentIsland.soundLabel',
    sectionKey: 'settings.tabs.agentIsland',
    descriptionKey: 'settings.agentIsland.soundHint',
  },
});

export default {
  id: 'agent-island',
  order: 10,
  entries: Object.values(agentIslandSettings),
} satisfies SettingsSearchModule;
