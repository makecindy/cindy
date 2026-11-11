import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const storageManagementCardSettings = defineSettings({
  aboutStorageRemoteMediaLabel: {
    id: 'settings.about.storage.remoteMediaLabel',
    fallbackTargetId: 'settings-panel-storage',
    tab: 'storage',
    targetId: 'settings-search-settings-about-storage-remoteMediaLabel',
    titleKey: 'settings.about.storage.remoteMediaLabel',
    sectionKey: 'settings.tabs.storage',
    descriptionKey: 'settings.about.storage.remoteMediaDescription',
  },
  storage: {
    id: 'storage',
    tab: 'storage',
    targetId: 'settings-panel-storage',
    titleKey: TAB_LABEL_KEY['storage'],
    sectionKey: 'settings.about.storage.title',
  },
  aboutStorageDatabaseSectionTitle: {
    id: 'settings.about.storage.databaseSectionTitle',
    fallbackTargetId: 'settings-panel-storage',
    tab: 'storage',
    targetId: 'settings-search-settings-about-storage-databaseSectionTitle',
    titleKey: 'settings.about.storage.databaseSectionTitle',
    sectionKey: 'settings.tabs.storage',
  },
  aboutStorageMediaSectionTitle: {
    id: 'settings.about.storage.mediaSectionTitle',
    fallbackTargetId: 'settings-panel-storage',
    tab: 'storage',
    targetId: 'settings-search-settings-about-storage-mediaSectionTitle',
    titleKey: 'settings.about.storage.mediaSectionTitle',
    sectionKey: 'settings.tabs.storage',
    descriptionKey: 'settings.about.storage.mediaSectionHint',
  },
  aboutStorageCleanupLabel: {
    id: 'settings.about.storage.cleanupLabel',
    fallbackTargetId: 'settings-panel-storage',
    tab: 'storage',
    targetId: 'settings-search-settings-about-storage-cleanupLabel',
    titleKey: 'settings.about.storage.cleanupLabel',
    descriptionKey: 'settings.about.storage.cleanupDescription',
    sectionKey: 'settings.tabs.storage',
  },
  aboutStorageReconcileLabel: {
    id: 'settings.about.storage.reconcileLabel',
    fallbackTargetId: 'settings-panel-storage',
    tab: 'storage',
    targetId: 'settings-search-settings-about-storage-reconcileLabel',
    titleKey: 'settings.about.storage.reconcileLabel',
    descriptionKey: 'settings.about.storage.reconcileDescription',
    sectionKey: 'settings.tabs.storage',
  },
  aboutStorageDbSlimmingLabel: {
    id: 'settings.about.storage.dbSlimmingLabel',
    fallbackTargetId: 'settings-panel-storage',
    tab: 'storage',
    targetId: 'settings-search-settings-about-storage-dbSlimmingLabel',
    titleKey: 'settings.about.storage.dbSlimmingLabel',
    descriptionKey: 'settings.about.storage.dbSlimmingDescription',
    sectionKey: 'settings.tabs.storage',
  },
  aboutStorageDbSizeWarningThresholdLabel: {
    id: 'settings.about.storage.dbSizeWarningThresholdLabel',
    fallbackTargetId: 'settings-panel-storage',
    tab: 'storage',
    targetId: 'settings-search-settings-about-storage-dbSizeWarningThresholdLabel',
    titleKey: 'settings.about.storage.dbSizeWarningThresholdLabel',
    descriptionKey: 'settings.about.storage.dbSizeWarningThresholdDescription',
    sectionKey: 'settings.tabs.storage',
  },
  aboutStorageDbSizeWarningDisableLabel: {
    id: 'settings.about.storage.dbSizeWarningDisableLabel',
    fallbackTargetId: 'settings-panel-storage',
    tab: 'storage',
    targetId: 'settings-search-settings-about-storage-dbSizeWarningDisableLabel',
    titleKey: 'settings.about.storage.dbSizeWarningDisableLabel',
    descriptionKey: 'settings.about.storage.dbSizeWarningDisableDescription',
    sectionKey: 'settings.tabs.storage',
  },
});

export default {
  id: 'storage',
  order: 17,
  entries: Object.values(storageManagementCardSettings),
} satisfies SettingsSearchModule;
