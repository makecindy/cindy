import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from '../settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const usageHistorySettings = defineSettings({
  usage: {
    id: 'usage',
    tab: 'usage',
    targetId: 'settings-panel-usage',
    titleKey: TAB_LABEL_KEY['usage'],
    sectionKey: 'settings.tabs.usage',
  },
});

export default {
  id: 'usage',
  order: 4,
  entries: Object.values(usageHistorySettings),
} satisfies SettingsSearchModule;
