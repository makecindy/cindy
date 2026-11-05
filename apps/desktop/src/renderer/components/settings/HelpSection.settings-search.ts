import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const helpSettings = defineSettings({
  help: {
    id: 'help',
    tab: 'help',
    targetId: 'settings-panel-help',
    titleKey: TAB_LABEL_KEY['help'],
    sectionKey: 'settings.sections.help',
  },
  gettingStartedTitle: {
    id: 'settings.help.gettingStarted.title',
    fallbackTargetId: 'settings-panel-help',
    tab: 'help',
    targetId: 'settings-search-settings-help-gettingStarted-title',
    titleKey: 'settings.help.gettingStarted.title',
    sectionKey: 'settings.tabs.help',
  },
  workflowsTitle: {
    id: 'settings.help.workflows.title',
    fallbackTargetId: 'settings-panel-help',
    tab: 'help',
    targetId: 'settings-search-settings-help-workflows-title',
    titleKey: 'settings.help.workflows.title',
    sectionKey: 'settings.tabs.help',
    descriptionKey: 'settings.help.workflows.description',
  },
  recommendedWaysTitle: {
    id: 'settings.help.recommendedWays.title',
    fallbackTargetId: 'settings-panel-help',
    tab: 'help',
    targetId: 'settings-search-settings-help-recommendedWays-title',
    titleKey: 'settings.help.recommendedWays.title',
    sectionKey: 'settings.tabs.help',
    descriptionKey: 'settings.help.recommendedWays.description',
  },
  qnaTitle: {
    id: 'settings.help.qnaTitle',
    fallbackTargetId: 'settings-panel-help',
    tab: 'help',
    targetId: 'settings-search-settings-help-qnaTitle',
    titleKey: 'settings.help.qnaTitle',
    sectionKey: 'settings.tabs.help',
  },
  linuxUpdatesTitle: {
    id: 'settings.help.linuxUpdates.title',
    fallbackTargetId: 'settings-panel-help',
    tab: 'help',
    targetId: 'settings-search-settings-help-linuxUpdates-title',
    titleKey: 'settings.help.linuxUpdates.title',
    sectionKey: 'settings.tabs.help',
    descriptionKey: 'settings.help.linuxUpdates.description',
    isVisible: ({ platform }) => platform === 'linux',
  },
});

export default {
  id: 'help',
  order: 15,
  entries: Object.values(helpSettings),
} satisfies SettingsSearchModule;
