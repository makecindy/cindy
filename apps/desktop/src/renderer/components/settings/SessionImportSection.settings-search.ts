import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const sessionImportSettings = defineSettings({
  import: {
    id: 'import',
    tab: 'import',
    targetId: 'settings-panel-import',
    titleKey: TAB_LABEL_KEY['import'],
    sectionKey: 'settings.sections.import',
  },
});

export default {
  id: 'import',
  order: 11,
  entries: Object.values(sessionImportSettings),
} satisfies SettingsSearchModule;
