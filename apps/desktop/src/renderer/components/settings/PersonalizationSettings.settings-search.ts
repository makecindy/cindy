import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const personalizationSettings = defineSettings({
  personalization: {
    id: 'personalization',
    tab: 'personalization',
    targetId: 'settings-panel-personalization',
    titleKey: TAB_LABEL_KEY['personalization'],
    sectionKey: 'settings.tabs.personalization',
  },
  userPrompt: {
    id: 'personalization.userPrompt',
    tab: 'personalization',
    targetId: 'settings-search-target-personalization-user-prompt',
    titleKey: 'settings.sections.personalization',
    sectionKey: 'settings.sections.personalization',
    aliases: ['prompt', 'instructions', '提示词', '指令'],
  },
  memory: {
    id: 'personalization.memory',
    tab: 'personalization',
    targetId: 'settings-search-target-personalization-memory',
    titleKey: 'settings.sections.memory',
    sectionKey: 'settings.sections.memory',
    aliases: ['memories', '记忆'],
  },
  subagents: {
    id: 'personalization.subagents',
    tab: 'personalization',
    targetId: 'settings-search-target-personalization-subagents',
    titleKey: 'settings.sections.subagentModels',
    sectionKey: 'settings.sections.subagentModels',
  },
  auxiliaryModels: {
    id: 'personalization.auxiliaryModels',
    tab: 'personalization',
    targetId: 'settings-search-target-personalization-auxiliary-models',
    titleKey: 'settings.sections.auxiliaryModels',
    sectionKey: 'settings.sections.auxiliaryModels',
  },
  visionBridge: {
    id: 'personalization.visionBridge',
    tab: 'personalization',
    targetId: 'settings-search-target-personalization-vision-bridge',
    titleKey: 'settings.sections.visionBridge',
    sectionKey: 'settings.sections.visionBridge',
  },
  terminalShell: {
    id: 'personalization.terminalShell',
    tab: 'personalization',
    targetId: 'settings-search-target-personalization-terminal-shell',
    titleKey: 'settings.sections.terminalShell',
    sectionKey: 'settings.sections.terminalShell',
    aliases: ['terminal', 'shell', '终端'],
  },
  linkOpen: {
    id: 'personalization.linkOpen',
    tab: 'personalization',
    targetId: 'settings-search-target-personalization-link-open',
    titleKey: 'settings.sections.linkOpen',
    sectionKey: 'settings.sections.linkOpen',
  },
  tips: {
    id: 'personalization.tips',
    tab: 'personalization',
    targetId: 'settings-search-target-personalization-tips',
    titleKey: 'settings.sections.compatMode',
    sectionKey: 'settings.sections.compatMode',
  },
});

export default {
  id: 'personalization',
  order: 1,
  entries: Object.values(personalizationSettings),
} satisfies SettingsSearchModule;
