import type { SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by AgentResourceSection. */
export default {
  id: 'AgentResourceSection',
  order: 30,
  entries: [
    { id: 'settings.agentResource.preset', fallbackTargetId: 'settings-agent-resource', tab: 'general', targetId: 'settings-search-settings-agentResource-preset', titleKey: 'settings.agentResource.preset', sectionKey: 'settings.sections.agentResource' },
    { id: 'settings.agentResource.maxConcurrent', fallbackTargetId: 'settings-agent-resource', tab: 'general', targetId: 'settings-search-settings-agentResource-maxConcurrent', titleKey: 'settings.agentResource.maxConcurrent', sectionKey: 'settings.sections.agentResource', descriptionKey: 'settings.agentResource.maxConcurrentHint' },
    { id: 'settings.agentResource.priority', fallbackTargetId: 'settings-agent-resource', tab: 'general', targetId: 'settings-search-settings-agentResource-priority', titleKey: 'settings.agentResource.priority', sectionKey: 'settings.sections.agentResource', descriptionKey: 'settings.agentResource.priorityHint' },
    { id: 'settings.agentResource.capThreads', fallbackTargetId: 'settings-agent-resource', tab: 'general', targetId: 'settings-search-settings-agentResource-capThreads', titleKey: 'settings.agentResource.capThreads', sectionKey: 'settings.sections.agentResource', descriptionKey: 'settings.agentResource.capThreadsHint' },

  ],
} satisfies SettingsSearchModule;
