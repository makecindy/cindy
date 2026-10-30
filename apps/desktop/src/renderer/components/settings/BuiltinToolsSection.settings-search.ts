import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'builtin-tools',
  order: 8,
  entries: [
    { id: 'builtinTools', tab: 'builtin-tools', targetId: 'settings-panel-builtin-tools', titleKey: 'settings.tabs.builtinTools', sectionKey: 'settings.sections.mcpServers' },
    { id: 'settings.builtinTools.title', fallbackTargetId: 'settings-panel-builtin-tools', tab: 'builtin-tools', targetId: 'settings-search-settings-builtinTools-title', titleKey: 'settings.builtinTools.title', sectionKey: 'settings.tabs.builtinTools', descriptionKey: 'settings.builtinTools.description' },
  ],
} satisfies SettingsSearchModule;
