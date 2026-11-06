import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by WindowBehaviorSection. */
export const windowBehaviorSettings = defineSettings({
  devicesKeepAwake: {
    id: 'settings.devices.keepAwake',
    fallbackTargetId: 'settings-window-behavior',
    tab: 'general',
    targetId: 'settings-search-settings-devices-keepAwake',
    titleKey: 'settings.devices.keepAwake',
    sectionKey: 'settings.sections.windowBehavior',
    descriptionKey: 'settings.devices.keepAwakeHint',
  },
  loginItemLabel: {
    id: 'settings.windowBehavior.loginItem.label',
    fallbackTargetId: 'settings-window-behavior',
    tab: 'general',
    targetId: 'settings-search-login-item',
    titleKey: 'settings.windowBehavior.loginItem.label',
    aliases: ['开机启动', '开机自启', '开机自动启动', 'startup', 'launch at login'],
    sectionKey: 'settings.sections.windowBehavior',
    descriptionKey: 'settings.windowBehavior.loginItem.hint',
    isVisible: ({ platform }) => platform === 'darwin' || platform === 'win32',
  },
  menubarLabel: {
    id: 'settings.windowBehavior.menubar.label',
    fallbackTargetId: 'settings-window-behavior',
    tab: 'general',
    targetId: 'settings-search-menubar',
    titleKey: 'settings.windowBehavior.menubar.label',
    sectionKey: 'settings.sections.windowBehavior',
    descriptionKey: 'settings.windowBehavior.menubar.hint',
    isVisible: ({ platform }) => platform === 'darwin',
  },
  closeBehaviorLabel: {
    id: 'settings.windowBehavior.closeBehavior.label',
    fallbackTargetId: 'settings-window-behavior',
    tab: 'general',
    targetId: 'settings-search-settings-windowBehavior-closeBehavior-label',
    titleKey: 'settings.windowBehavior.closeBehavior.label',
    sectionKey: 'settings.sections.windowBehavior',
    descriptionKey: 'settings.windowBehavior.closeBehavior.hint',
    options: [
      { value: 'tray', labelKey: 'settings.windowBehavior.closeBehavior.tray', isVisible: ({ platform }) => platform === 'win32' },
      { value: 'minimize', labelKey: 'settings.windowBehavior.closeBehavior.minimize', isVisible: ({ platform }) => platform === 'linux' },
      { value: 'quit', labelKey: 'settings.windowBehavior.closeBehavior.quit' },
    ],
    isVisible: ({ platform }) => platform === 'linux' || platform === 'win32',
  },
  swallowActivationClickLabel: {
    id: 'settings.windowBehavior.swallowActivationClickLabel',
    fallbackTargetId: 'settings-window-behavior',
    tab: 'general',
    targetId: 'settings-search-activation-click',
    titleKey: 'settings.windowBehavior.swallowActivationClickLabel',
    sectionKey: 'settings.sections.windowBehavior',
    descriptionKey: 'settings.windowBehavior.swallowActivationClickHint',
    isVisible: ({ platform }) => platform === 'darwin' || platform === 'win32',
  },
});

export default {
  id: 'WindowBehaviorSection',
  order: 30,
  entries: Object.values(windowBehaviorSettings),
} satisfies SettingsSearchModule;
