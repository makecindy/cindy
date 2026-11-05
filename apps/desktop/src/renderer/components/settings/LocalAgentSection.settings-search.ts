import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

export const localAgentSettings = defineSettings({
  connections: {
    id: 'localAgent.connections',
    tab: 'remote-control',
    targetId: 'settings-search-target-local-agent',
    titleKey: 'localAgent.title',
    sectionKey: 'settings.sections.remoteControl',
    aliases: ['local agent', 'local app', 'revoke connection', '本机应用', '撤销连接'],
  },
});

export default {
  id: 'local-agent',
  order: 2,
  entries: Object.values(localAgentSettings),
} satisfies SettingsSearchModule;
