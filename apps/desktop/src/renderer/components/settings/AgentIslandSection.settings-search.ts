import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'agent-island',
  order: 10,
  entries: [
    { id: 'agentIsland', tab: 'agent-island', targetId: 'settings-panel-agent-island', titleKey: 'settings.tabs.agentIsland', sectionKey: 'settings.sections.agentIsland' },
    { id: 'settings.agentIsland.enableLabel', fallbackTargetId: 'settings-panel-agent-island', tab: 'agent-island', targetId: 'settings-search-settings-agentIsland-enableLabel', titleKey: 'settings.agentIsland.enableLabel', sectionKey: 'settings.tabs.agentIsland', descriptionKey: 'settings.agentIsland.enableHint' },
    { id: 'settings.agentIsland.displayLabel', fallbackTargetId: 'settings-panel-agent-island', tab: 'agent-island', targetId: 'settings-search-settings-agentIsland-displayLabel', titleKey: 'settings.agentIsland.displayLabel', sectionKey: 'settings.tabs.agentIsland', descriptionKey: 'settings.agentIsland.displayHint' },
    { id: 'settings.agentIsland.skinLabel', fallbackTargetId: 'settings-panel-agent-island', tab: 'agent-island', targetId: 'settings-search-settings-agentIsland-skinLabel', titleKey: 'settings.agentIsland.skinLabel', sectionKey: 'settings.tabs.agentIsland', descriptionKey: 'settings.agentIsland.skinHint' },
    { id: 'settings.agentIsland.soundLabel', fallbackTargetId: 'settings-panel-agent-island', tab: 'agent-island', targetId: 'settings-search-settings-agentIsland-soundLabel', titleKey: 'settings.agentIsland.soundLabel', sectionKey: 'settings.tabs.agentIsland', descriptionKey: 'settings.agentIsland.soundHint' },

  ],
} satisfies SettingsSearchModule;
