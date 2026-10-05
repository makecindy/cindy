import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'providers',
  order: 5,
  entries: [
    { id: 'providers', tab: 'providers', targetId: 'settings-panel-providers', titleKey: 'settings.tabs.providers', sectionKey: 'settings.sections.providers' },
    { id: 'settings.providers.addProvider', fallbackTargetId: 'settings-panel-providers', tab: 'providers', targetId: 'settings-search-settings-providers-addProvider', titleKey: 'settings.providers.addProvider', sectionKey: 'settings.tabs.providers' },
  ],
} satisfies SettingsSearchModule;
