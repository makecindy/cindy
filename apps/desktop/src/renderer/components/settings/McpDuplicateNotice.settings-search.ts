import type { SettingsSearchModule } from './settingsSearchTypes';

/** The detected groups are dynamic; search navigates to the notice or its parent. */
export default {
  id: 'mcp-duplicates',
  order: 8.1,
  entries: [{
    id: 'mcp.duplicates',
    tab: 'builtin-tools',
    targetId: 'settings-mcp-duplicates',
    fallbackTargetId: 'settings-panel-builtin-tools',
    titleKey: 'settings.mcp.duplicates.title',
    descriptionKey: 'settings.mcp.duplicates.description',
    sectionKey: 'settings.tabs.builtinTools',
    aliases: ['MCP', 'Claude Code'],
  }],
} satisfies SettingsSearchModule;
