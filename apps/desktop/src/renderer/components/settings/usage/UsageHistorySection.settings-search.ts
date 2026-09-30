import type { SettingsSearchModule } from '../settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'usage',
  order: 4,
  entries: [
    { id: 'usage', tab: 'usage', targetId: 'settings-panel-usage', titleKey: 'settings.tabs.usage', sectionKey: 'settings.tabs.usage' },
  ],
} satisfies SettingsSearchModule;
