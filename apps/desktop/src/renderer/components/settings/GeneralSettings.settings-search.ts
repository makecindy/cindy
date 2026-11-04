import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const generalSettings = defineSettings({
  general: {
    id: 'general',
    tab: 'general',
    targetId: 'settings-panel-general',
    titleKey: TAB_LABEL_KEY['general'],
    sectionKey: 'settings.tabs.general',
  },
  user: {
    id: 'general.user',
    tab: 'general',
    targetId: 'settings-search-target-general-user',
    titleKey: 'settings.sections.user',
    sectionKey: 'settings.sections.user',
  },
  setupMigration: {
    id: 'general.setupMigration',
    tab: 'general',
    targetId: 'settings-setup-migration',
    titleKey: 'setupMigration.settings.title',
    sectionKey: 'setupMigration.settings.title',
    aliases: ['migrate', 'migration assistant', 'new computer', '迁移', '迁移助理', '新电脑'],
  },
  language: {
    id: 'general.language',
    tab: 'general',
    targetId: 'settings-search-target-general-language',
    titleKey: 'settings.sections.language',
    sectionKey: 'settings.sections.language',
  },
  notifications: {
    id: 'general.notifications',
    tab: 'general',
    targetId: 'settings-notifications',
    titleKey: 'settings.sections.notifications',
    sectionKey: 'settings.sections.notifications',
  },
  bots: {
    id: 'general.bots',
    tab: 'general',
    targetId: 'settings-bots',
    titleKey: 'settings.sections.bots',
    sectionKey: 'settings.sections.bots',
  },
  windowBehavior: {
    id: 'general.windowBehavior',
    tab: 'general',
    targetId: 'settings-window-behavior',
    titleKey: 'settings.sections.windowBehavior',
    sectionKey: 'settings.sections.windowBehavior',
  },
  composer: {
    id: 'general.composer',
    tab: 'general',
    targetId: 'settings-composer',
    titleKey: 'settings.sections.composer',
    sectionKey: 'settings.sections.composer',
  },
  collaboration: {
    id: 'general.collaboration',
    tab: 'general',
    targetId: 'settings-collaboration',
    titleKey: 'settings.sections.collaboration',
    sectionKey: 'settings.sections.collaboration',
    aliases: ['collaboration'],
  },
  newChatPermission: {
    id: 'general.newChatPermission',
    tab: 'general',
    targetId: 'settings-new-chat-default-permission',
    titleKey: 'settings.newChatDefaults.title',
    sectionKey: 'settings.newChatDefaults.title',
  },
  agentResource: {
    id: 'general.agentResource',
    tab: 'general',
    targetId: 'settings-agent-resource',
    titleKey: 'settings.sections.agentResource',
    sectionKey: 'settings.sections.agentResource',
  },
  gitSafety: {
    id: 'general.gitSafety',
    tab: 'general',
    targetId: 'settings-search-target-general-git-safety',
    titleKey: 'settings.sections.gitSafety',
    sectionKey: 'settings.sections.gitSafety',
  },
  experimental: {
    id: 'general.experimental',
    tab: 'general',
    targetId: 'settings-search-target-general-experimental',
    titleKey: 'settings.sections.experimental',
    sectionKey: 'settings.sections.experimental',
  },
  piExtensions: {
    id: 'general.piExtensions',
    tab: 'general',
    targetId: 'settings-pi-extensions',
    titleKey: 'settings.piPackages.entryTitle',
    sectionKey: 'settings.piPackages.entryTitle',
  },
});

export default {
  id: 'general',
  order: 0,
  entries: Object.values(generalSettings),
} satisfies SettingsSearchModule;
