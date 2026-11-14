import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const modelAdvancedSettings = defineSettings({
  thinkingOverride: {
    id: 'settings.providers.models.advanced.thinkingOverride',
    tab: 'providers',
    targetId: 'settings-search-settings-providers-models-thinking-override',
    fallbackTargetId: 'settings-panel-providers',
    titleKey: 'settings.providers.models.advanced.thinkingOverride.label',
    descriptionKey: 'settings.providers.models.advanced.thinkingOverride.sourceHint',
    sectionKey: 'settings.tabs.providers',
    aliases: ['thinking', 'reasoning', 'effort'],
  },
});

export default {
  id: 'providers',
  order: 5,
  entries: Object.values(modelAdvancedSettings),
} satisfies SettingsSearchModule;
