import type { SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by GitSafetySection. */
export default {
  id: 'GitSafetySection',
  order: 30,
  entries: [
    { id: 'settings.gitSafety.autoSnapshotTitle', fallbackTargetId: 'settings-search-target-general-git-safety', tab: 'general', targetId: 'settings-search-settings-gitSafety-autoSnapshotTitle', titleKey: 'settings.gitSafety.autoSnapshotTitle', sectionKey: 'settings.sections.gitSafety' },

  ],
} satisfies SettingsSearchModule;
