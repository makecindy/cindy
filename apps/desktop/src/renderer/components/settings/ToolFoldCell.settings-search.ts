import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by ToolFoldCell (设置 → 通用 → 实验性功能 → 工具载荷折叠). */
export const toolFoldSettings = defineSettings({
  enable: {
    id: 'general.toolFold',
    tab: 'general',
    targetId: 'settings-tool-fold',
    titleKey: 'settings.toolFold.cell.title',
    descriptionKey: 'settings.toolFold.cell.description',
    sectionKey: 'settings.sections.experimental',
    aliases: ['工具载荷折叠', 'tool fold', '上下文折叠', '折叠工具结果', 'folding'],
  },
});

export default {
  id: 'general.tool-fold',
  order: 4,
  entries: Object.values(toolFoldSettings),
} satisfies SettingsSearchModule;
