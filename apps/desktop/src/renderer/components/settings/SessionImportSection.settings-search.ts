import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'import',
  order: 11,
  entries: [
    { id: 'import', tab: 'import', targetId: 'settings-panel-import', titleKey: 'settings.tabs.import', sectionKey: 'settings.sections.import' },
  ],
} satisfies SettingsSearchModule;
