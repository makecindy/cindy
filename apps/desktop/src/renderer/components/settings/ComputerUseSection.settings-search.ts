import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'computer-use',
  order: 9,
  entries: [
    { id: 'computerUse', tab: 'computer-use', targetId: 'settings-panel-computer-use', titleKey: 'settings.tabs.computerUse', sectionKey: 'settings.computerUse.title' },
    { id: 'settings.computerUse.browser.title', fallbackTargetId: 'settings-panel-computer-use', tab: 'computer-use', targetId: 'settings-search-settings-computerUse-browser-title', titleKey: 'settings.computerUse.browser.title', sectionKey: 'settings.tabs.computerUse', descriptionKey: 'settings.computerUse.browser.description' },
    { id: 'settings.computerUse.directControl.title', fallbackTargetId: 'settings-panel-computer-use', tab: 'computer-use', targetId: 'settings-search-settings-computerUse-directControl-title', titleKey: 'settings.computerUse.directControl.title', sectionKey: 'settings.tabs.computerUse', descriptionKey: 'settings.computerUse.directControl.description' },
    { id: 'settings.computerUse.android.title', fallbackTargetId: 'settings-panel-computer-use', tab: 'computer-use', targetId: 'settings-search-settings-computerUse-android-title', titleKey: 'settings.computerUse.android.title', sectionKey: 'settings.tabs.computerUse', descriptionKey: 'settings.computerUse.android.description' },
    { id: 'settings.computerUse.android.adb.title', fallbackTargetId: 'settings-panel-computer-use', tab: 'computer-use', targetId: 'settings-search-settings-computerUse-android-adb-title', titleKey: 'settings.computerUse.android.adb.title', sectionKey: 'settings.tabs.computerUse' },
    { id: 'settings.computerUse.directControl.permissions.title', fallbackTargetId: 'settings-panel-computer-use', tab: 'computer-use', targetId: 'settings-search-settings-computerUse-directControl-permissions-title', titleKey: 'settings.computerUse.directControl.permissions.title', sectionKey: 'settings.tabs.computerUse', isVisible: ({ platform }) => platform === 'darwin' },
    { id: 'settings.computerUse.directControl.permissions.accessibilityLabel', fallbackTargetId: 'settings-panel-computer-use', tab: 'computer-use', targetId: 'settings-search-settings-computerUse-directControl-permissions-accessibilityLabel', titleKey: 'settings.computerUse.directControl.permissions.accessibilityLabel', sectionKey: 'settings.tabs.computerUse', isVisible: ({ platform }) => platform === 'darwin' },
    { id: 'settings.computerUse.directControl.permissions.screenRecordingLabel', fallbackTargetId: 'settings-panel-computer-use', tab: 'computer-use', targetId: 'settings-search-settings-computerUse-directControl-permissions-screenRecordingLabel', titleKey: 'settings.computerUse.directControl.permissions.screenRecordingLabel', sectionKey: 'settings.tabs.computerUse', isVisible: ({ platform }) => platform === 'darwin' },

  ],
} satisfies SettingsSearchModule;
