import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'personalization',
  order: 1,
  entries: [
    { id: 'personalization', tab: 'personalization', targetId: 'settings-panel-personalization', titleKey: 'settings.tabs.personalization', sectionKey: 'settings.tabs.personalization' },
    { id: 'personalization.userPrompt', tab: 'personalization', targetId: 'settings-search-target-personalization-user-prompt', titleKey: 'settings.sections.personalization', sectionKey: 'settings.sections.personalization', aliases: ['prompt', 'instructions', '提示词', '指令'] },
    { id: 'personalization.memory', tab: 'personalization', targetId: 'settings-search-target-personalization-memory', titleKey: 'settings.sections.memory', sectionKey: 'settings.sections.memory', aliases: ['memories', '记忆'] },
    { id: 'personalization.subagents', tab: 'personalization', targetId: 'settings-search-target-personalization-subagents', titleKey: 'settings.sections.subagentModels', sectionKey: 'settings.sections.subagentModels' },
    { id: 'personalization.auxiliaryModels', tab: 'personalization', targetId: 'settings-search-target-personalization-auxiliary-models', titleKey: 'settings.sections.auxiliaryModels', sectionKey: 'settings.sections.auxiliaryModels' },
    { id: 'personalization.visionBridge', tab: 'personalization', targetId: 'settings-search-target-personalization-vision-bridge', titleKey: 'settings.sections.visionBridge', sectionKey: 'settings.sections.visionBridge' },
    { id: 'personalization.contacts', tab: 'personalization', targetId: 'settings-contacts', titleKey: 'settings.contacts.title', sectionKey: 'settings.contacts.title' },
    { id: 'personalization.compaction', tab: 'personalization', targetId: 'settings-search-target-personalization-compaction', titleKey: 'settings.sections.compaction', sectionKey: 'settings.sections.compaction' },
    { id: 'personalization.terminalShell', tab: 'personalization', targetId: 'settings-search-target-personalization-terminal-shell', titleKey: 'settings.sections.terminalShell', sectionKey: 'settings.sections.terminalShell', aliases: ['terminal', 'shell', '终端'] },
    { id: 'personalization.linkOpen', tab: 'personalization', targetId: 'settings-search-target-personalization-link-open', titleKey: 'settings.sections.linkOpen', sectionKey: 'settings.sections.linkOpen' },
    { id: 'personalization.streamFade', tab: 'personalization', targetId: 'settings-search-target-personalization-stream-fade', titleKey: 'settings.sections.streamFade', sectionKey: 'settings.sections.streamFade' },
    { id: 'personalization.tips', tab: 'personalization', targetId: 'settings-search-target-personalization-tips', titleKey: 'settings.sections.compatMode', sectionKey: 'settings.sections.compatMode' },
  ],
} satisfies SettingsSearchModule;
