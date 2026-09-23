import type { SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by WindowBehaviorSection. */
export default {
  id: 'WindowBehaviorSection',
  order: 30,
  entries: [
    { id: 'settings.devices.keepAwake', fallbackTargetId: 'settings-window-behavior', tab: 'general', targetId: 'settings-search-settings-devices-keepAwake', titleKey: 'settings.devices.keepAwake', sectionKey: 'settings.sections.windowBehavior', descriptionKey: 'settings.devices.keepAwakeHint' },
    { id: 'settings.windowBehavior.loginItem.label', fallbackTargetId: 'settings-window-behavior', tab: 'general', targetId: 'settings-search-login-item', titleKey: 'settings.windowBehavior.loginItem.label', sectionKey: 'settings.sections.windowBehavior', descriptionKey: 'settings.windowBehavior.loginItem.hint', isVisible: ({ platform }) => platform === 'darwin' || platform === 'win32' },
    { id: 'settings.windowBehavior.closeBehavior.label', fallbackTargetId: 'settings-window-behavior', tab: 'general', targetId: 'settings-search-settings-windowBehavior-closeBehavior-label', titleKey: 'settings.windowBehavior.closeBehavior.label', sectionKey: 'settings.sections.windowBehavior', descriptionKey: 'settings.windowBehavior.closeBehavior.hint', isVisible: ({ platform }) => platform === 'linux' || platform === 'win32' },
    { id: 'settings.windowBehavior.swallowActivationClickLabel', fallbackTargetId: 'settings-window-behavior', tab: 'general', targetId: 'settings-search-activation-click', titleKey: 'settings.windowBehavior.swallowActivationClickLabel', sectionKey: 'settings.sections.windowBehavior', descriptionKey: 'settings.windowBehavior.swallowActivationClickHint', isVisible: ({ platform }) => platform === 'darwin' || platform === 'win32' },

  ],
} satisfies SettingsSearchModule;
