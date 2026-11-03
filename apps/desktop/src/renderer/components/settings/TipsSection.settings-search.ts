import type { SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by TipsSection. */
export default {
  id: 'TipsSection',
  order: 30,
  entries: [
    { id: 'settings.promptRecommendation.label', fallbackTargetId: 'settings-search-target-personalization-tips', tab: 'personalization', targetId: 'settings-search-settings-promptRecommendation-label', titleKey: 'settings.promptRecommendation.label', sectionKey: 'settings.sections.compatMode', descriptionKey: 'settings.promptRecommendation.description' },

  ],
} satisfies SettingsSearchModule;
