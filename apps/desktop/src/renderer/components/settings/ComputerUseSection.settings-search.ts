import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const computerUseSettings = defineSettings({
  computerUse: {
    id: 'computerUse',
    tab: 'computer-use',
    targetId: 'settings-panel-computer-use',
    titleKey: TAB_LABEL_KEY['computer-use'],
    sectionKey: 'settings.computerUse.title',
  },
  browserTitle: {
    id: 'settings.computerUse.browser.title',
    fallbackTargetId: 'settings-panel-computer-use',
    tab: 'computer-use',
    targetId: 'settings-search-settings-computerUse-browser-title',
    titleKey: 'settings.computerUse.browser.title',
    sectionKey: 'settings.tabs.computerUse',
    descriptionKey: 'settings.computerUse.browser.description',
  },
  directControlTitle: {
    id: 'settings.computerUse.directControl.title',
    fallbackTargetId: 'settings-panel-computer-use',
    tab: 'computer-use',
    targetId: 'settings-search-settings-computerUse-directControl-title',
    titleKey: 'settings.computerUse.directControl.title',
    sectionKey: 'settings.tabs.computerUse',
    descriptionKey: 'settings.computerUse.directControl.description',
  },
  androidTitle: {
    id: 'settings.computerUse.android.title',
    fallbackTargetId: 'settings-panel-computer-use',
    tab: 'computer-use',
    targetId: 'settings-search-settings-computerUse-android-title',
    titleKey: 'settings.computerUse.android.title',
    sectionKey: 'settings.tabs.computerUse',
    descriptionKey: 'settings.computerUse.android.description',
  },
  androidAdbTitle: {
    id: 'settings.computerUse.android.adb.title',
    fallbackTargetId: 'settings-panel-computer-use',
    tab: 'computer-use',
    targetId: 'settings-search-settings-computerUse-android-adb-title',
    titleKey: 'settings.computerUse.android.adb.title',
    sectionKey: 'settings.tabs.computerUse',
  },
  directControlPermissionsTitle: {
    id: 'settings.computerUse.directControl.permissions.title',
    fallbackTargetId: 'settings-panel-computer-use',
    tab: 'computer-use',
    targetId: 'settings-search-settings-computerUse-directControl-permissions-title',
    titleKey: 'settings.computerUse.directControl.permissions.title',
    sectionKey: 'settings.tabs.computerUse',
    isVisible: ({ platform }) => platform === 'darwin',
  },
  directControlPermissionsAccessibilityLabel: {
    id: 'settings.computerUse.directControl.permissions.accessibilityLabel',
    fallbackTargetId: 'settings-panel-computer-use',
    tab: 'computer-use',
    targetId: 'settings-search-settings-computerUse-directControl-permissions-accessibilityLabel',
    titleKey: 'settings.computerUse.directControl.permissions.accessibilityLabel',
    sectionKey: 'settings.tabs.computerUse',
    isVisible: ({ platform }) => platform === 'darwin',
  },
  directControlPermissionsScreenRecordingLabel: {
    id: 'settings.computerUse.directControl.permissions.screenRecordingLabel',
    fallbackTargetId: 'settings-panel-computer-use',
    tab: 'computer-use',
    targetId: 'settings-search-settings-computerUse-directControl-permissions-screenRecordingLabel',
    titleKey: 'settings.computerUse.directControl.permissions.screenRecordingLabel',
    sectionKey: 'settings.tabs.computerUse',
    isVisible: ({ platform }) => platform === 'darwin',
  },
});

export default {
  id: 'computer-use',
  order: 9,
  entries: Object.values(computerUseSettings),
} satisfies SettingsSearchModule;
