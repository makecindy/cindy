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
    aliases: ['device link', 'devices', '设备互联', '我的设备'],
  },
  systemScreenSharing: {
    id: 'remoteControl.systemScreenSharing',
    isVisible: ({ mode, platform }) => mode === 'cloud' && platform === 'darwin',
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-system-sharing',
    titleKey: 'settings.remoteControl.systemSharing.title',
    descriptionKey: 'settings.remoteControl.systemSharing.description',
    sectionKey: 'settings.sections.remoteControl',
    aliases: [
      'Screen Sharing',
      'VNC',
      'High Performance',
      'Mac to Mac',
      '屏幕共享',
      '系统屏幕共享',
      '高性能',
      '远程桌面',
    ],
  },
  systemScreenSharingMode: {
    id: 'remoteControl.systemScreenSharingMode',
    isVisible: ({ mode, platform }) => mode === 'cloud' && platform === 'darwin',
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-system-sharing-mode',
    titleKey: 'settings.remoteControl.systemSharing.modeTitle',
    descriptionKey: 'settings.remoteControl.systemSharing.modeDescription',
    sectionKey: 'settings.sections.remoteControl',
    aliases: ['High Performance', 'Standard', '高性能', '标准', '屏幕共享模式'],
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
