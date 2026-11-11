import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const remoteControlSettings = defineSettings({
  relay: {
    id: 'remoteControl.relay',
    isVisible: ({ mode }) => mode === 'cloud',
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-relay',
    titleKey: 'settings.remoteControl.relay.route.title',
    sectionKey: 'settings.sections.remoteControl',
    aliases: [
      'relay',
      'self-hosted relay',
      'connection route',
      '中转',
      '自建中转',
      '中转服务',
      '连接线路',
    ],
  },
  devices: {
    id: 'remoteControl.devices',
    isVisible: ({ mode }) => mode === 'cloud',
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-devices',
    titleKey: 'settings.remoteControl.sections.myDevices',
    sectionKey: 'settings.sections.remoteControl',
    aliases: ['device link', 'devices', '设备互联', '我的设备', '设备列表'],
  },
  v2: {
    id: 'remoteControl.v2',
    isVisible: ({ mode }) => mode === 'cloud',
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-v2',
    titleKey: 'settings.remoteControl.v2.switch.title',
    descriptionKey: 'settings.remoteControl.v2.switch.hint',
    sectionKey: 'settings.sections.remoteControl',
    aliases: ['Agent-Net', 'agent net', 'device-link', 'topology', 'new connection', '拓扑', '新版连接', '连接拓扑'],
  },
  onlyEncrypted: {
    id: 'remoteControl.onlyEncrypted',
    isVisible: ({ mode }) => mode === 'cloud',
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-only-encrypted',
    fallbackTargetId: 'settings-search-target-remote-v2',
    titleKey: 'settings.remoteControl.v2.onlyEncrypted',
    descriptionKey: 'settings.remoteControl.v2.onlyEncryptedHint',
    sectionKey: 'settings.sections.remoteControl',
    aliases: ['Agent-Net only', 'encrypted connections', '仅使用 Agent-Net', '加密连接'],
  },
  ssh: {
    id: 'remoteControl.ssh',
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-ssh',
    titleKey: 'settings.remoteControl.sections.ssh',
    sectionKey: 'settings.sections.remoteControl',
    aliases: ['SSH', 'SSH host', 'SSH hosts', 'SSH主机', 'remote host', '远程主机', '主机'],
  },
  remoteControl: {
    id: 'remoteControl',
    tab: 'remote-control',
    targetId: 'settings-panel-remote-control',
    titleKey: TAB_LABEL_KEY['remote-control'],
    sectionKey: 'settings.sections.remoteControl',
  },
});

export default {
  id: 'remote-control',
  order: 2,
  entries: Object.values(remoteControlSettings),
} satisfies SettingsSearchModule;
