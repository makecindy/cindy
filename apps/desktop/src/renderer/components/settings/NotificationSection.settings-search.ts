import type { SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by NotificationSection. */
export default {
  id: 'NotificationSection',
  order: 30,
  entries: [
    { id: 'settings.notifications.sessionDoneLabel', fallbackTargetId: 'settings-notifications', tab: 'general', targetId: 'settings-search-settings-notifications-sessionDoneLabel', titleKey: 'settings.notifications.sessionDoneLabel', sectionKey: 'settings.sections.notifications', descriptionKey: 'settings.notifications.sessionDoneHint' },

  ],
} satisfies SettingsSearchModule;
