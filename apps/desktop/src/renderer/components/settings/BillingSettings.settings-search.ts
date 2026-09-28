import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'billing',
  order: 3,
  entries: [
    { id: 'billing', tab: 'billing', targetId: 'settings-panel-billing', titleKey: 'settings.tabs.billing', sectionKey: 'settings.sections.billing' },
  ],
} satisfies SettingsSearchModule;
