import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'general',
  order: 0,
  entries: [
    { id: 'general', tab: 'general', targetId: 'settings-panel-general', titleKey: 'settings.tabs.general', sectionKey: 'settings.tabs.general' },
    { id: 'general.user', tab: 'general', targetId: 'settings-search-target-general-user', titleKey: 'settings.sections.user', sectionKey: 'settings.sections.user' },
    { id: 'general.appearance', tab: 'general', targetId: 'settings-search-target-general-appearance', titleKey: 'settings.sections.appearance', sectionKey: 'settings.sections.appearance' },
    { id: 'general.language', tab: 'general', targetId: 'settings-search-target-general-language', titleKey: 'settings.sections.language', sectionKey: 'settings.sections.language' },
    { id: 'general.notifications', tab: 'general', targetId: 'settings-notifications', titleKey: 'settings.sections.notifications', sectionKey: 'settings.sections.notifications' },
    { id: 'general.bots', tab: 'general', targetId: 'settings-bots', titleKey: 'settings.sections.bots', sectionKey: 'settings.sections.bots' },
    { id: 'general.windowBehavior', tab: 'general', targetId: 'settings-window-behavior', titleKey: 'settings.sections.windowBehavior', sectionKey: 'settings.sections.windowBehavior' },
    { id: 'general.composer', tab: 'general', targetId: 'settings-composer', titleKey: 'settings.sections.composer', sectionKey: 'settings.sections.composer' },
    { id: 'general.collaboration', tab: 'general', targetId: 'settings-collaboration', titleKey: 'settings.sections.collaboration', sectionKey: 'settings.sections.collaboration' },
    { id: 'general.agentResource', tab: 'general', targetId: 'settings-agent-resource', titleKey: 'settings.sections.agentResource', sectionKey: 'settings.sections.agentResource' },
    { id: 'general.gitSafety', tab: 'general', targetId: 'settings-search-target-general-git-safety', titleKey: 'settings.sections.gitSafety', sectionKey: 'settings.sections.gitSafety' },
    { id: 'general.experimental', tab: 'general', targetId: 'settings-search-target-general-experimental', titleKey: 'settings.sections.experimental', sectionKey: 'settings.sections.experimental' },
    { id: 'general.piExtensions', tab: 'general', targetId: 'settings-pi-extensions', titleKey: 'settings.piPackages.entryTitle', sectionKey: 'settings.piPackages.entryTitle' },
  ],
} satisfies SettingsSearchModule;
