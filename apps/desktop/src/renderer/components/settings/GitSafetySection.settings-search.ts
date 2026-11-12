import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by GitSafetySection. */
export const gitSafetySettings = defineSettings({
  autoSnapshotTitle: {
    id: 'settings.gitSafety.autoSnapshotTitle',
    fallbackTargetId: 'settings-search-target-general-git-safety',
    tab: 'general',
    targetId: 'settings-search-settings-gitSafety-autoSnapshotTitle',
    titleKey: 'settings.gitSafety.autoSnapshotTitle',
    sectionKey: 'settings.sections.gitSafety',
    options: [
      { value: 'off', labelKey: 'settings.gitSafety.modes.off' },
      { value: 'existing-git', labelKey: 'settings.gitSafety.modes.existingGit' },
      { value: 'all-projects', labelKey: 'settings.gitSafety.modes.allProjects' },
    ],
    descriptionKey: 'settings.gitSafety.description',
  },
});

export default {
  id: 'GitSafetySection',
  order: 30,
  entries: Object.values(gitSafetySettings),
} satisfies SettingsSearchModule;
