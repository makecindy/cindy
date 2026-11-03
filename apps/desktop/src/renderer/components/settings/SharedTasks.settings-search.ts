import type { SettingsSearchModule } from './settingsSearchTypes';

export default {
  id: 'shared-tasks',
  order: 3,
  entries: [{ id: 'sharedTasks', tab: 'shared-tasks', targetId: 'settings-panel-shared-tasks', titleKey: 'sharedTask.title', sectionKey: 'sharedTask.manageSharing', keywordKeys: ['sharedTask.join', 'sharedTask.invitation'] }],
} satisfies SettingsSearchModule;
