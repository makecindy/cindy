import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by LiveCompactCell (设置 → 通用 → 实验功能 → 边做边压). */
export const liveCompactSettings = defineSettings({
  enable: {
    id: 'general.liveCompact',
    tab: 'general',
    targetId: 'settings-live-compact',
    titleKey: 'settings.liveCompact.cell.title',
    descriptionKey: 'settings.liveCompact.cell.description',
    sectionKey: 'settings.sections.experimental',
    keywordKeys: ['settings.liveCompact.cell.sourceLabel'],
    aliases: ['边做边压', '上下文压缩', 'live compact', 'compaction', '压缩'],
  },
  shadow: {
    id: 'general.liveCompact.shadow',
    tab: 'general',
    targetId: 'settings-live-compact-shadow',
    fallbackTargetId: 'settings-live-compact',
    titleKey: 'settings.liveCompact.shadow.label',
    descriptionKey: 'settings.liveCompact.shadow.description',
    sectionKey: 'settings.sections.experimental',
    aliases: ['影子原文', '原文备份', 'snapshots', 'spine', '清理压缩原文'],
  },
});

export default {
  id: 'general.live-compact',
  order: 4,
  entries: Object.values(liveCompactSettings),
} satisfies SettingsSearchModule;
