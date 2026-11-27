import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by AgentResourceSection. */
export const agentResourceSettings = defineSettings({
  preset: {
    id: 'settings.agentResource.preset',
    fallbackTargetId: 'settings-agent-resource',
    tab: 'general',
    targetId: 'settings-search-settings-agentResource-preset',
    titleKey: 'settings.agentResource.preset',
    sectionKey: 'settings.sections.agentResource',
    options: [
      { value: 'full', labelKey: 'settings.agentResource.presets.full' },
      { value: 'balanced', labelKey: 'settings.agentResource.presets.balanced' },
      { value: 'background', labelKey: 'settings.agentResource.presets.background' },
    ],
  },
  maxConcurrent: {
    id: 'settings.agentResource.maxConcurrent',
    fallbackTargetId: 'settings-agent-resource',
    tab: 'general',
    targetId: 'settings-search-settings-agentResource-maxConcurrent',
    titleKey: 'settings.agentResource.maxConcurrent',
    sectionKey: 'settings.sections.agentResource',
    descriptionKey: 'settings.agentResource.maxConcurrentHint',
  },
  priority: {
    id: 'settings.agentResource.priority',
    fallbackTargetId: 'settings-agent-resource',
    tab: 'general',
    targetId: 'settings-search-settings-agentResource-priority',
    titleKey: 'settings.agentResource.priority',
    sectionKey: 'settings.sections.agentResource',
    descriptionKey: 'settings.agentResource.priorityHint',
    options: [
      { value: 'normal', labelKey: 'settings.agentResource.priorityOptions.normal' },
      { value: 'low', labelKey: 'settings.agentResource.priorityOptions.low' },
      { value: 'lowest', labelKey: 'settings.agentResource.priorityOptions.lowest' },
    ],
  },
  capThreads: {
    id: 'settings.agentResource.capThreads',
    fallbackTargetId: 'settings-agent-resource',
    tab: 'general',
    targetId: 'settings-search-settings-agentResource-capThreads',
    titleKey: 'settings.agentResource.capThreads',
    sectionKey: 'settings.sections.agentResource',
    descriptionKey: 'settings.agentResource.capThreadsHint',
  },
});

export default {
  id: 'AgentResourceSection',
  order: 30,
  entries: Object.values(agentResourceSettings),
} satisfies SettingsSearchModule;
