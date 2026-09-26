import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'shortcuts',
  order: 7,
  entries: [
    { id: 'shortcuts', tab: 'shortcuts', targetId: 'settings-panel-shortcuts', titleKey: 'settings.tabs.shortcuts', sectionKey: 'settings.sections.shortcuts' },
    { id: 'settings.shortcuts.accessories.title', fallbackTargetId: 'settings-panel-shortcuts', tab: 'shortcuts', targetId: 'settings-search-settings-shortcuts-accessories-title', titleKey: 'settings.shortcuts.accessories.title', sectionKey: 'settings.tabs.shortcuts', descriptionKey: 'settings.shortcuts.accessories.description' },
  ],
} satisfies SettingsSearchModule;
