import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by CollaborationSection. */
export const collaborationSettings = defineSettings({
  workerSoftLimit: {
    id: 'settings.collaboration.workerSoftLimit',
    fallbackTargetId: 'settings-collaboration',
    tab: 'general',
    targetId: 'settings-search-settings-collaboration-workerSoftLimit',
    titleKey: 'settings.collaboration.workerSoftLimit',
    sectionKey: 'settings.sections.collaboration',
    descriptionKey: 'settings.collaboration.workerSoftLimitHint',
  },
  workerHardLimit: {
    id: 'settings.collaboration.workerHardLimit',
    fallbackTargetId: 'settings-collaboration',
    tab: 'general',
    targetId: 'settings-search-settings-collaboration-workerHardLimit',
    titleKey: 'settings.collaboration.workerHardLimit',
    sectionKey: 'settings.sections.collaboration',
    descriptionKey: 'settings.collaboration.workerHardLimitHint',
  },
  idleRelease: {
    id: 'settings.collaboration.idleRelease',
    fallbackTargetId: 'settings-collaboration',
    tab: 'general',
    targetId: 'settings-search-settings-collaboration-idleRelease',
    titleKey: 'settings.collaboration.idleRelease',
    sectionKey: 'settings.sections.collaboration',
    descriptionKey: 'settings.collaboration.idleReleaseHint',
  },
});

export default {
  id: 'CollaborationSection',
  order: 30,
  entries: Object.values(collaborationSettings),
} satisfies SettingsSearchModule;
