import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by SubagentModelSection. */
export const subagentModelSettings = defineSettings({
  subagentModelsSmartRoutingLabel: {
    id: 'settings.subagentModels.smartRouting.label',
    fallbackTargetId: 'settings-search-target-personalization-subagents',
    tab: 'personalization',
    targetId: 'settings-search-settings-subagentModels-smartRouting-label',
    titleKey: 'settings.subagentModels.smartRouting.label',
    sectionKey: 'settings.sections.subagentModels',
  },
});

export default {
  id: 'SubagentModelSection',
  order: 30,
  entries: Object.values(subagentModelSettings),
} satisfies SettingsSearchModule;
