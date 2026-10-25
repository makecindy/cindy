import type { SettingsSearchModule } from './settingsSearchTypes';

export default {
  id: 'local-agent', order: 2,
  entries: [{ id: 'localAgent.connections', tab: 'remote-control', targetId: 'settings-search-target-local-agent',
    titleKey: 'localAgent.title', sectionKey: 'settings.sections.remoteControl',
    aliases: ['local agent', 'local app', 'revoke connection', '本机应用', '撤销连接'] }],
} satisfies SettingsSearchModule;
