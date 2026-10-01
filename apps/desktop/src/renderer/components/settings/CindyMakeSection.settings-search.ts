import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'cindy-make',
  order: 14,
  entries: [
    { id: 'cindyMake', tab: 'cindy-make', targetId: 'settings-panel-cindy-make', titleKey: 'settings.tabs.cindyMake', sectionKey: 'settings.tabs.cindyMake' },
    { id: 'settings.cindyMake.source.title', fallbackTargetId: 'settings-panel-cindy-make', tab: 'cindy-make', targetId: 'settings-search-settings-cindyMake-source-title', titleKey: 'settings.cindyMake.source.title', sectionKey: 'settings.tabs.cindyMake', descriptionKey: 'settings.cindyMake.source.description' },
    { id: 'settings.cindyMake.syncBeforeBuild.title', fallbackTargetId: 'settings-panel-cindy-make', tab: 'cindy-make', targetId: 'settings-search-settings-cindyMake-syncBeforeBuild-title', titleKey: 'settings.cindyMake.syncBeforeBuild.title', sectionKey: 'settings.tabs.cindyMake', descriptionKey: 'settings.cindyMake.syncBeforeBuild.description' },
  ],
} satisfies SettingsSearchModule;
