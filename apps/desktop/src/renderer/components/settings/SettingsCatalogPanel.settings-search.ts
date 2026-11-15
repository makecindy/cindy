import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const settingsCatalogPanelSettings = defineSettings({
  plugins: {
    id: 'plugins',
    tab: 'ghosts',
    targetId: 'settings-panel-ghosts',
    titleKey: TAB_LABEL_KEY['ghosts'],
    sectionKey: 'settings.tabs.ghosts',
  },
});

export default {
  id: 'ghosts',
  order: 13,
  entries: Object.values(settingsCatalogPanelSettings),
} satisfies SettingsSearchModule;
