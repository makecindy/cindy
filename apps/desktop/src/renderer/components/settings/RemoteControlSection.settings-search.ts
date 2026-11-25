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
    // 「重新加入」: a removed computer's own card offers it here, so searching for it lands on this card.
    keywordKeys: ['settings.devices.delete', 'settings.devices.deleteTitle', 'settings.devices.rejoin.action', 'settings.devices.rejoin.hint'],
    aliases: ['device link', 'devices', 'device management', '设备互联', '我的设备', '设备列表', '设备管理'],
  },
  // 「我的设备」里的「云主机」一行:开通、查看进度与管理都在账号中心完成,这里只是入口。
  cloudComputer: {
    id: 'remoteControl.cloudComputer',
    isVisible: ({ mode }) => mode === 'cloud',
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-devices',
    titleKey: 'settings.remoteControl.cloudComputer.title',
    sectionKey: 'settings.remoteControl.sections.myDevices',
    // 按钮名在各语言里都能搜到(添加云主机 / 查看进度 / 管理云主机)。
    keywordKeys: [
      'settings.remoteControl.cloudComputer.actions.addCloud',
      'settings.remoteControl.cloudComputer.actions.preparingCloud',
      'settings.remoteControl.cloudComputer.actions.manageCloud',
    ],
    aliases: ['cloud computer', 'cloud desktop', 'cloud host', '云主机', '云电脑'],
  },
  localNetwork: {
    id: 'remoteControl.localNetwork',
    isVisible: ({ mode }) => mode === 'cloud',
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-devices',
    titleKey: 'settings.devices.localNetwork.label',
    descriptionKey: 'settings.devices.localNetwork.deniedHint',
    sectionKey: 'settings.remoteControl.sections.myDevices',
    aliases: ['local network', 'LAN', 'direct connection', '本地网络', '局域网', '直连', '本地网络权限'],
  },
  v2: {
    id: 'remoteControl.v2',
    isVisible: ({ mode }) => mode === 'cloud',
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-v2',
    titleKey: 'settings.remoteControl.v2.switch.title',
    descriptionKey: 'settings.remoteControl.v2.switch.hint',
    sectionKey: 'settings.remoteControl.v2.sectionTitle',
    aliases: ['Agent-Net', 'agent net', 'device-link', 'topology', 'new connection', '拓扑', '新版连接', '连接拓扑'],
  },
  ssh: {
    id: 'remoteControl.ssh',
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-ssh',
    titleKey: 'settings.remoteControl.sections.ssh',
    sectionKey: 'settings.sections.remoteControl',
    keywordKeys: ['settings.remote.importedAgentHint'],
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
