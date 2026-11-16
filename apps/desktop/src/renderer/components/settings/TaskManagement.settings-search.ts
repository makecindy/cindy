import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

export const taskManagementSettings = defineSettings({
  page: {
    id: 'task-management',
    tab: 'storage',
    targetId: 'settings-task-auto-archive-section',
    titleKey: 'taskManagement.archive',
    sectionKey: 'settings.tabs.storage',
    descriptionKey: 'taskManagement.scope',
  },
  enabled: {
    id: 'task-management.autoArchive',
    tab: 'storage',
    targetId: 'settings-task-auto-archive',
    titleKey: 'taskManagement.enabled',
    descriptionKey: 'taskManagement.description',
    sectionKey: 'taskManagement.archive',
    aliases: ['自动归档', '闲置任务', 'auto archive', 'idle tasks'],
  },
  days: {
    id: 'task-management.archiveDays',
    tab: 'storage',
    targetId: 'settings-task-archive-days',
    titleKey: 'taskManagement.days',
    descriptionKey: 'taskManagement.daysHint',
    sectionKey: 'taskManagement.archive',
    options: [
      { value: '7', labelKey: 'taskManagement.days7' },
      { value: '14', labelKey: 'taskManagement.days14' },
      { value: '30', labelKey: 'taskManagement.days30' },
      { value: 'custom', labelKey: 'taskManagement.customDays' },
    ],
  },
});
export default {
  id: 'task-management',
  order: 35,
  entries: Object.values(taskManagementSettings),
} satisfies SettingsSearchModule;
