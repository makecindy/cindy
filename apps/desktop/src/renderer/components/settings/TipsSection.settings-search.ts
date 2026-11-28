import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by TipsSection. */
export const tipsSettings = defineSettings({
  promptRecommendationLabel: {
    id: 'settings.promptRecommendation.label',
    fallbackTargetId: 'settings-search-target-personalization-tips',
    tab: 'personalization',
    targetId: 'settings-search-settings-promptRecommendation-label',
    titleKey: 'settings.promptRecommendation.label',
    sectionKey: 'settings.sections.compatMode',
    descriptionKey: 'settings.promptRecommendation.description',
  },
  localPathDropConfirm: {
    id: 'personalization.localPathDropConfirm',
    tab: 'personalization',
    targetId: 'settings-local-path-drop-confirm',
    titleKey: 'settings.localPathDropConfirm.cell.label',
    descriptionKey: 'settings.localPathDropConfirm.cell.description',
    sectionKey: 'settings.sections.compatMode',
    aliases: ['拖入文件', '拖拽文件', 'VS Code 拖入', 'drag and drop', 'confirm drag'],
  },
});

export default {
  id: 'TipsSection',
  order: 30,
  entries: Object.values(tipsSettings),
} satisfies SettingsSearchModule;
