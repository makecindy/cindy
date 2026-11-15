import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by WorktreeRecycleCard. */
export const worktreeRecycleCardSettings = defineSettings({
  worktreeRecycleTitle: {
    id: 'settings.worktreeRecycle.title',
    fallbackTargetId: 'settings-panel-storage',
    tab: 'storage',
    targetId: 'settings-search-settings-worktreeRecycle-title',
    titleKey: 'settings.worktreeRecycle.title',
    sectionKey: 'settings.tabs.storage',
  },
});

export default {
  id: 'WorktreeRecycleCard',
  order: 30,
  entries: Object.values(worktreeRecycleCardSettings),
} satisfies SettingsSearchModule;
