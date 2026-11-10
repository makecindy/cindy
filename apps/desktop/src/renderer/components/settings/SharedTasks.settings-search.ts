import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

export const sharedTasksSettings = defineSettings({
  sharedTasks: {
    id: 'sharedTasks',
    tab: 'shared-tasks',
    targetId: 'settings-panel-shared-tasks',
    titleKey: 'sharedTask.title',
    sectionKey: 'sharedTask.manageSharing',
    keywordKeys: ['sharedTask.join', 'sharedTask.invitation'],
  },
});

export default {
  id: 'shared-tasks',
  order: 3,
  entries: Object.values(sharedTasksSettings),
} satisfies SettingsSearchModule;
