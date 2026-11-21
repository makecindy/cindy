import { supportsLiquidGlass } from '../../../shared/appearanceSettings';
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
  codexCompaction: {
    id: 'personalization.codexCompaction',
    tab: 'personalization',
    targetId: 'settings-search-target-codex-compaction',
    titleKey: 'settings.compaction.codex.label',
    sectionKey: 'settings.compaction.title',
    descriptionKey: 'settings.compaction.codex.description',
    keywordKeys: ['settings.compaction.codex.hint'],
    aliases: ['server compaction', 'local summary', '服务器压缩', '本地摘要'],
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
  terminalShell: {
    id: 'personalization.terminalShell',
    tab: 'personalization',
    targetId: 'settings-search-target-personalization-terminal-shell',
    titleKey: 'settings.sections.terminalShell',
    sectionKey: 'settings.sections.terminalShell',
    aliases: ['terminal', 'shell', '终端'],
  },
  liquidGlass: {
    id: 'settings.personalization.liquidGlass.label',
    tab: 'personalization',
    targetId: 'settings-search-target-personalization-liquid-glass',
    fallbackTargetId: 'settings-panel-personalization',
    titleKey: 'settings.personalization.liquidGlass.label',
    descriptionKey: 'settings.personalization.liquidGlass.hint',
    sectionKey: 'settings.personalization.liquidGlass.section',
    aliases: ['液体玻璃', '液態玻璃', '液體玻璃', 'Liquid Glass'],
    isVisible: ({ platform }) => supportsLiquidGlass(platform),
  },
  liquidGlassClarity: {
    id: 'settings.personalization.liquidGlass.clarity',
    tab: 'personalization',
    targetId: 'settings-search-target-personalization-liquid-glass-clarity',
    fallbackTargetId: 'settings-panel-personalization',
    titleKey: 'settings.personalization.liquidGlass.clarity',
    descriptionKey: 'settings.personalization.liquidGlass.clarityHint',
    sectionKey: 'settings.personalization.liquidGlass.section',
    aliases: ['玻璃透明度', '玻璃通透度', 'glass clarity', 'glass transparency'],
    isVisible: ({ platform }) => supportsLiquidGlass(platform),
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
