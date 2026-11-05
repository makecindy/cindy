import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const builtinToolsSettings = defineSettings({
  builtinTools: {
    id: 'builtinTools',
    tab: 'builtin-tools',
    targetId: 'settings-panel-builtin-tools',
    titleKey: TAB_LABEL_KEY['builtin-tools'],
    sectionKey: 'settings.sections.mcpServers',
  },
  title: {
    id: 'settings.builtinTools.title',
    fallbackTargetId: 'settings-panel-builtin-tools',
    tab: 'builtin-tools',
    targetId: 'settings-search-settings-builtinTools-title',
    titleKey: 'settings.builtinTools.title',
    sectionKey: 'settings.tabs.builtinTools',
    descriptionKey: 'settings.builtinTools.description',
  },
});

export default {
  id: 'builtin-tools',
  order: 8,
  entries: Object.values(builtinToolsSettings),
} satisfies SettingsSearchModule;
