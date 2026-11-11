import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import {
  APP_SHORTCUT_DEFINITIONS,
  isAppShortcutAvailableOnPlatform,
} from '../../../shared/appShortcuts';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const keyboardShortcutsSettings = defineSettings({
  shortcuts: {
    id: 'shortcuts',
    tab: 'shortcuts',
    targetId: 'settings-panel-shortcuts',
    titleKey: TAB_LABEL_KEY['shortcuts'],
    sectionKey: 'settings.sections.shortcuts',
  },
  shortcutsAccessoriesTitle: {
    id: 'settings.shortcuts.accessories.title',
    fallbackTargetId: 'settings-panel-shortcuts',
    tab: 'shortcuts',
    targetId: 'settings-search-settings-shortcuts-accessories-title',
    titleKey: 'settings.shortcuts.accessories.title',
    sectionKey: 'settings.tabs.shortcuts',
    descriptionKey: 'settings.shortcuts.accessories.description',
  },
});

export const appShortcutSettings = defineSettings(Object.fromEntries(
  APP_SHORTCUT_DEFINITIONS.filter((definition) => !definition.hiddenInSettings).map((definition) => [definition.id, {
    id: 'shortcuts.' + definition.id,
    tab: 'shortcuts' as const,
    targetId: 'settings-shortcut-' + definition.id,
    fallbackTargetId: 'settings-panel-shortcuts',
    titleKey: definition.labelKey,
    descriptionKey: definition.descriptionKey,
    sectionKey: 'settings.tabs.shortcuts',
    isVisible: ({ platform }: { platform: string }) =>
      isAppShortcutAvailableOnPlatform(definition.id, platform),
  }]),
));

export default {
  id: 'shortcuts',
  order: 7,
  entries: [
    ...Object.values(keyboardShortcutsSettings),
    ...Object.values(appShortcutSettings),
  ],
} satisfies SettingsSearchModule;
