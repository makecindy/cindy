import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const aboutSettings = defineSettings({
  about: {
    id: 'about',
    tab: 'about',
    targetId: 'settings-panel-about',
    titleKey: TAB_LABEL_KEY['about'],
    sectionKey: 'settings.sections.about',
  },
  appVersionLabel: {
    id: 'settings.about.appVersionLabel',
    isVisible: ({ region }) => region === 'cn',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-appVersionLabel',
    titleKey: 'settings.about.appVersionLabel',
    sectionKey: 'settings.tabs.about',
  },
  autoUpdateLabel: {
    id: 'settings.about.autoUpdateLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-autoUpdateLabel',
    titleKey: 'settings.about.autoUpdateLabel',
    descriptionKey: 'settings.about.autoUpdateDescription',
    descriptionKeyForContext: ({ platform }) => platform === 'linux'
      ? 'settings.about.linuxUpdateDescription' : undefined,
    aliases: ['自动更新', '自动升级', 'auto update'],
    sectionKey: 'settings.tabs.about',
  },
  analyticsLabel: {
    id: 'settings.about.analyticsLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-analyticsLabel',
    titleKey: 'settings.about.analyticsLabel',
    sectionKey: 'settings.tabs.about',
    descriptionKey: 'settings.about.analyticsDescription',
  },
  debugLogLabel: {
    id: 'settings.about.debugLogLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-debugLogLabel',
    titleKey: 'settings.about.debugLogLabel',
    sectionKey: 'settings.tabs.about',
    descriptionKey: 'settings.about.debugLogDescription',
  },
  logsDirLabel: {
    id: 'settings.about.logsDirLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-logsDirLabel',
    titleKey: 'settings.about.logsDirLabel',
    sectionKey: 'settings.tabs.about',
  },
  logUploadCrashAutoLabel: {
    id: 'settings.about.logUpload.crashAutoLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-logUpload-crashAutoLabel',
    titleKey: 'settings.about.logUpload.crashAutoLabel',
    sectionKey: 'settings.tabs.about',
  },
  logUploadUploadLabel: {
    id: 'settings.about.logUpload.uploadLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-logUpload-uploadLabel',
    titleKey: 'settings.about.logUpload.uploadLabel',
    sectionKey: 'settings.tabs.about',
  },
});

export default {
  id: 'about',
  order: 16,
  entries: Object.values(aboutSettings),
} satisfies SettingsSearchModule;
