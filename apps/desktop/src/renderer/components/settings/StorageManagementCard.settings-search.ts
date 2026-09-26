import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'storage',
  order: 17,
  entries: [
    { id: 'storage', tab: 'storage', targetId: 'settings-panel-storage', titleKey: 'settings.tabs.storage', sectionKey: 'settings.about.storage.title' },
    { id: 'settings.about.storage.databaseSectionTitle', fallbackTargetId: 'settings-panel-storage', tab: 'storage', targetId: 'settings-search-settings-about-storage-databaseSectionTitle', titleKey: 'settings.about.storage.databaseSectionTitle', sectionKey: 'settings.tabs.storage' },
    { id: 'settings.about.storage.mediaSectionTitle', fallbackTargetId: 'settings-panel-storage', tab: 'storage', targetId: 'settings-search-settings-about-storage-mediaSectionTitle', titleKey: 'settings.about.storage.mediaSectionTitle', sectionKey: 'settings.tabs.storage', descriptionKey: 'settings.about.storage.mediaSectionHint' },
    { id: 'settings.about.storage.cleanupLabel', fallbackTargetId: 'settings-panel-storage', tab: 'storage', targetId: 'settings-search-settings-about-storage-cleanupLabel', titleKey: 'settings.about.storage.cleanupLabel', sectionKey: 'settings.tabs.storage' },
    { id: 'settings.about.storage.reconcileLabel', fallbackTargetId: 'settings-panel-storage', tab: 'storage', targetId: 'settings-search-settings-about-storage-reconcileLabel', titleKey: 'settings.about.storage.reconcileLabel', sectionKey: 'settings.tabs.storage' },
    { id: 'settings.about.storage.dbSlimmingLabel', fallbackTargetId: 'settings-panel-storage', tab: 'storage', targetId: 'settings-search-settings-about-storage-dbSlimmingLabel', titleKey: 'settings.about.storage.dbSlimmingLabel', sectionKey: 'settings.tabs.storage' },
    { id: 'settings.about.storage.dbSizeWarningThresholdLabel', fallbackTargetId: 'settings-panel-storage', tab: 'storage', targetId: 'settings-search-settings-about-storage-dbSizeWarningThresholdLabel', titleKey: 'settings.about.storage.dbSizeWarningThresholdLabel', sectionKey: 'settings.tabs.storage' },
    { id: 'settings.about.storage.dbSizeWarningDisableLabel', fallbackTargetId: 'settings-panel-storage', tab: 'storage', targetId: 'settings-search-settings-about-storage-dbSizeWarningDisableLabel', titleKey: 'settings.about.storage.dbSizeWarningDisableLabel', sectionKey: 'settings.tabs.storage' },
  ],
} satisfies SettingsSearchModule;
