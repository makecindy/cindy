import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'about',
  order: 16,
  entries: [
    { id: 'about', tab: 'about', targetId: 'settings-panel-about', titleKey: 'settings.tabs.about', sectionKey: 'settings.sections.about' },
    { id: 'settings.about.appVersionLabel', isVisible: ({ region }) => region === 'cn', fallbackTargetId: 'settings-panel-about', tab: 'about', targetId: 'settings-search-settings-about-appVersionLabel', titleKey: 'settings.about.appVersionLabel', sectionKey: 'settings.tabs.about' },
    { id: 'settings.about.autoUpdateLabel', fallbackTargetId: 'settings-panel-about', tab: 'about', targetId: 'settings-search-settings-about-autoUpdateLabel', titleKey: 'settings.about.autoUpdateLabel', sectionKey: 'settings.tabs.about' },
    { id: 'settings.about.analyticsLabel', fallbackTargetId: 'settings-panel-about', tab: 'about', targetId: 'settings-search-settings-about-analyticsLabel', titleKey: 'settings.about.analyticsLabel', sectionKey: 'settings.tabs.about' },
    { id: 'settings.about.debugLogLabel', fallbackTargetId: 'settings-panel-about', tab: 'about', targetId: 'settings-search-settings-about-debugLogLabel', titleKey: 'settings.about.debugLogLabel', sectionKey: 'settings.tabs.about' },
    { id: 'settings.about.logsDirLabel', fallbackTargetId: 'settings-panel-about', tab: 'about', targetId: 'settings-search-settings-about-logsDirLabel', titleKey: 'settings.about.logsDirLabel', sectionKey: 'settings.tabs.about' },
    { id: 'settings.about.logUpload.crashAutoLabel', fallbackTargetId: 'settings-panel-about', tab: 'about', targetId: 'settings-search-settings-about-logUpload-crashAutoLabel', titleKey: 'settings.about.logUpload.crashAutoLabel', sectionKey: 'settings.tabs.about' },
    { id: 'settings.about.logUpload.uploadLabel', fallbackTargetId: 'settings-panel-about', tab: 'about', targetId: 'settings-search-settings-about-logUpload-uploadLabel', titleKey: 'settings.about.logUpload.uploadLabel', sectionKey: 'settings.tabs.about' },
  ],
} satisfies SettingsSearchModule;
