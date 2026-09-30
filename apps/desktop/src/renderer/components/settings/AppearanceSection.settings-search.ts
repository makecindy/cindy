import type { SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by AppearanceSection. */
export default {
  id: 'AppearanceSection',
  order: 30,
  entries: [
    { id: 'settings.appearance.modeLabel', fallbackTargetId: 'settings-search-target-general-appearance', tab: 'general', targetId: 'settings-search-settings-appearance-modeLabel', titleKey: 'settings.appearance.modeLabel', sectionKey: 'settings.sections.appearance' },
    { id: 'settings.appearance.themeLabel', fallbackTargetId: 'settings-search-target-general-appearance', tab: 'general', targetId: 'settings-search-settings-appearance-themeLabel', titleKey: 'settings.appearance.themeLabel', sectionKey: 'settings.sections.appearance' },
    { id: 'settings.appearance.localThemes.title', fallbackTargetId: 'settings-search-target-general-appearance', tab: 'general', targetId: 'settings-search-settings-appearance-localThemes-title', titleKey: 'settings.appearance.localThemes.title', sectionKey: 'settings.sections.appearance' },
    { id: 'settings.appearance.font.uiFamily.label', fallbackTargetId: 'settings-search-target-general-appearance', tab: 'general', targetId: 'settings-search-settings-appearance-font-uiFamily-label', titleKey: 'settings.appearance.font.uiFamily.label', sectionKey: 'settings.sections.appearance', descriptionKey: 'settings.appearance.font.uiFamily.description' },
    { id: 'settings.appearance.font.uiSize.label', fallbackTargetId: 'settings-search-target-general-appearance', tab: 'general', targetId: 'settings-search-settings-appearance-font-uiSize-label', titleKey: 'settings.appearance.font.uiSize.label', sectionKey: 'settings.sections.appearance', descriptionKey: 'settings.appearance.font.uiSize.description' },
    { id: 'settings.appearance.font.codeFamily.label', fallbackTargetId: 'settings-search-target-general-appearance', tab: 'general', targetId: 'settings-search-settings-appearance-font-codeFamily-label', titleKey: 'settings.appearance.font.codeFamily.label', sectionKey: 'settings.sections.appearance', descriptionKey: 'settings.appearance.font.codeFamily.description' },
    { id: 'settings.appearance.font.codeSize.label', fallbackTargetId: 'settings-search-target-general-appearance', tab: 'general', targetId: 'settings-search-settings-appearance-font-codeSize-label', titleKey: 'settings.appearance.font.codeSize.label', sectionKey: 'settings.sections.appearance', descriptionKey: 'settings.appearance.font.codeSize.description' },
    { id: 'settings.appearance.sidebarCardMode.label', fallbackTargetId: 'settings-search-target-general-appearance', tab: 'general', targetId: 'settings-search-settings-appearance-sidebarCardMode-label', titleKey: 'settings.appearance.sidebarCardMode.label', sectionKey: 'settings.sections.appearance', descriptionKey: 'settings.appearance.sidebarCardMode.hint' },
    { id: 'settings.appearance.sidebarMainListMode.label', fallbackTargetId: 'settings-search-target-general-appearance', tab: 'general', targetId: 'settings-search-settings-appearance-sidebarMainListMode-label', titleKey: 'settings.appearance.sidebarMainListMode.label', sectionKey: 'settings.sections.appearance', descriptionKey: 'settings.appearance.sidebarMainListMode.hint' },
    { id: 'settings.appearance.ghostPanelRestore.label', fallbackTargetId: 'settings-search-target-general-appearance', tab: 'general', targetId: 'settings-search-settings-appearance-ghostPanelRestore-label', titleKey: 'settings.appearance.ghostPanelRestore.label', sectionKey: 'settings.sections.appearance', descriptionKey: 'settings.appearance.ghostPanelRestore.hint' },

  ],
} satisfies SettingsSearchModule;
