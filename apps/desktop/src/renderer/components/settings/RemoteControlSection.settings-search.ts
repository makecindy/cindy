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
  // 只有组织成员才有云主机入口(useCloudComputerEntry),个人账号搜不到这一行。
  cloudComputer: {
    id: 'remoteControl.cloudComputer',
    isVisible: ({ mode, membershipKind }) => mode === 'cloud' && membershipKind === 'org',
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
  // 「这台电脑」卡片里的 SSH 访问(只在 macOS / Linux、非托管云实例上有;主开关关着时落到「我的设备」)。
  sshAccess: {
    id: 'remoteControl.sshAccess',
    isVisible: ({ mode, platform, managedCloudInstance }) =>
      mode === 'cloud' && (platform === 'darwin' || platform === 'linux') && managedCloudInstance !== true,
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-ssh-access',
    fallbackTargetId: 'settings-search-target-remote-devices',
    titleKey: 'settings.remoteControl.sshAccess.title',
    descriptionKey: 'settings.remoteControl.sshAccess.description',
    sectionKey: 'settings.remoteControl.sections.myDevices',
    keywordKeys: [
      'settings.remoteControl.sshAccess.addKey',
      'settings.remoteControl.sshAccess.endSessions',
    ],
    aliases: ['SSH', 'SSH access', 'authorized_keys', 'public key', 'remote login', 'SSH 访问', '公钥', '远程登录'],
  },
  localNetwork: {
    id: 'remoteControl.localNetwork',
    isVisible: ({ mode }) => mode === 'cloud',
    tab: 'remote-control',
    targetId: 'settings-search-target-remote-devices',
    titleKey: 'settings.devices.localNetwork.label',
    descriptionKey: 'settings.devices.localNetwork.deniedHint',
    sectionKey: 'settings.remoteControl.sections.myDevices',
    keywordKeys: [
      'settings.devices.localNetwork.promptedHint',
      'settings.devices.localNetwork.settingsHint',
    ],
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
