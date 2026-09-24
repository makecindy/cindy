import type { SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by VisionBridgeSection. */
export default {
  id: 'VisionBridgeSection',
  order: 30,
  entries: [
    { id: 'settings.visionBridge.enableLabel', fallbackTargetId: 'settings-search-target-personalization-vision-bridge', tab: 'personalization', targetId: 'settings-search-settings-visionBridge-enableLabel', titleKey: 'settings.visionBridge.enableLabel', sectionKey: 'settings.sections.visionBridge', descriptionKey: 'settings.visionBridge.enableHint' },
    { id: 'settings.visionBridge.targetModels.label', fallbackTargetId: 'settings-search-target-personalization-vision-bridge', tab: 'personalization', targetId: 'settings-search-settings-visionBridge-targetModels-label', titleKey: 'settings.visionBridge.targetModels.label', sectionKey: 'settings.sections.visionBridge', descriptionKey: 'settings.visionBridge.targetModels.hint' },
    { id: 'settings.visionBridge.backends.label', fallbackTargetId: 'settings-search-target-personalization-vision-bridge', tab: 'personalization', targetId: 'settings-search-settings-visionBridge-backends-label', titleKey: 'settings.visionBridge.backends.label', sectionKey: 'settings.sections.visionBridge', descriptionKey: 'settings.visionBridge.backends.hint' },

  ],
} satisfies SettingsSearchModule;
