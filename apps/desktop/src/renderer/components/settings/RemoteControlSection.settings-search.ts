import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'remote-control',
  order: 2,
  entries: [
    { id: 'remoteControl.devices', isVisible: ({ mode }) => mode === 'cloud', tab: 'remote-control', targetId: 'settings-search-target-remote-devices', titleKey: 'settings.remoteControl.sections.myDevices', sectionKey: 'settings.sections.remoteControl', aliases: ['device link', 'devices', '设备互联', '我的设备'] },
    { id: 'remoteControl.ssh', tab: 'remote-control', targetId: 'settings-search-target-remote-ssh', titleKey: 'settings.remoteControl.sections.ssh', sectionKey: 'settings.sections.remoteControl', aliases: ['SSH', 'SSH host', 'SSH hosts', 'SSH主机', 'remote host', '远程主机', '主机'] },
    { id: 'remoteControl', tab: 'remote-control', targetId: 'settings-panel-remote-control', titleKey: 'settings.tabs.remoteControl', sectionKey: 'settings.sections.remoteControl' },
  ],
} satisfies SettingsSearchModule;
