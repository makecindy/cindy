import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by AwayFromComputerSection (docs/product-rules/privacy-screen.md). */
export const awayFromComputerSettings = defineSettings({
  devicesKeepAwake: {
    id: 'settings.devices.keepAwake',
    fallbackTargetId: 'settings-away-from-computer',
    tab: 'general',
    targetId: 'settings-search-settings-devices-keepAwake',
    titleKey: 'settings.devices.keepAwake',
    sectionKey: 'settings.awayFromComputer.title',
    descriptionKey: 'settings.devices.keepAwakeHint',
    aliases: ['休眠', '睡眠', 'sleep'],
  },
  awayGuard: {
    id: 'settings.windowBehavior.awayGuard.label',
    fallbackTargetId: 'settings-away-from-computer',
    tab: 'general',
    targetId: 'settings-search-away-guard',
    titleKey: 'settings.windowBehavior.awayGuard.label',
    aliases: ['锁屏', '防窥', '隐私屏', '离开时继续工作', '遮挡屏幕', 'lock screen', 'privacy screen'],
    sectionKey: 'settings.awayFromComputer.title',
    descriptionKey: 'settings.windowBehavior.awayGuard.hint',
    isVisible: ({ platform }) => ['darwin', 'linux'].includes(platform),
  },
  awayGuardDelay: {
    id: 'settings.windowBehavior.awayGuard.delay.label',
    fallbackTargetId: 'settings-away-from-computer',
    tab: 'general',
    targetId: 'settings-search-away-guard-delay',
    titleKey: 'settings.windowBehavior.awayGuard.delay.label',
    sectionKey: 'settings.awayFromComputer.title',
    descriptionKey: 'settings.windowBehavior.awayGuard.delay.hint',
    options: [
      { value: '30', labelKey: 'settings.windowBehavior.awayGuard.delay.30' },
      { value: '60', labelKey: 'settings.windowBehavior.awayGuard.delay.60' },
      { value: '120', labelKey: 'settings.windowBehavior.awayGuard.delay.120' },
      { value: '300', labelKey: 'settings.windowBehavior.awayGuard.delay.300' },
      { value: 'system', labelKey: 'settings.windowBehavior.awayGuard.delay.system' },
    ],
    isVisible: ({ platform }) => ['darwin', 'linux'].includes(platform),
  },
});

export default {
  id: 'AwayFromComputerSection',
  order: 31,
  entries: Object.values(awayFromComputerSettings),
} satisfies SettingsSearchModule;
