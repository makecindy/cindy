import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'help',
  order: 15,
  entries: [
    { id: 'help', tab: 'help', targetId: 'settings-panel-help', titleKey: 'settings.tabs.help', sectionKey: 'settings.sections.help' },
    { id: 'settings.help.gettingStarted.title', fallbackTargetId: 'settings-panel-help', tab: 'help', targetId: 'settings-search-settings-help-gettingStarted-title', titleKey: 'settings.help.gettingStarted.title', sectionKey: 'settings.tabs.help' },
    { id: 'settings.help.workflows.title', fallbackTargetId: 'settings-panel-help', tab: 'help', targetId: 'settings-search-settings-help-workflows-title', titleKey: 'settings.help.workflows.title', sectionKey: 'settings.tabs.help', descriptionKey: 'settings.help.workflows.description' },
    { id: 'settings.help.recommendedWays.title', fallbackTargetId: 'settings-panel-help', tab: 'help', targetId: 'settings-search-settings-help-recommendedWays-title', titleKey: 'settings.help.recommendedWays.title', sectionKey: 'settings.tabs.help', descriptionKey: 'settings.help.recommendedWays.description' },
    { id: 'settings.help.qnaTitle', fallbackTargetId: 'settings-panel-help', tab: 'help', targetId: 'settings-search-settings-help-qnaTitle', titleKey: 'settings.help.qnaTitle', sectionKey: 'settings.tabs.help' },
    { id: 'settings.help.linuxUpdates.title', fallbackTargetId: 'settings-panel-help', tab: 'help', targetId: 'settings-search-settings-help-linuxUpdates-title', titleKey: 'settings.help.linuxUpdates.title', sectionKey: 'settings.tabs.help', descriptionKey: 'settings.help.linuxUpdates.description', isVisible: ({ platform }) => platform === 'linux' },
  ],
} satisfies SettingsSearchModule;
