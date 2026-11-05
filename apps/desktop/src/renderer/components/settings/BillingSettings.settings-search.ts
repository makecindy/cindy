import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const billingSettings = defineSettings({
  billing: {
    id: 'billing',
    tab: 'billing',
    targetId: 'settings-panel-billing',
    titleKey: TAB_LABEL_KEY['billing'],
    sectionKey: 'settings.sections.billing',
  },
});

export default {
  id: 'billing',
  order: 3,
  entries: Object.values(billingSettings),
} satisfies SettingsSearchModule;
