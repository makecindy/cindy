import type { SettingsSearchModule } from './settingsSearchTypes';

export default {
  id: 'cloud-instances',
  order: 3,
  entries: [
    {
      // 云实例在「远程连接 → 我的设备」的设备卡上;id 即 ?section=,
      // 与 REMOTE_CLOUD_INSTANCES_SECTION 一致,RemoteControlSection 据此展开「我的设备」。
      id: 'remoteControl.cloudInstances',
      tab: 'remote-control',
      targetId: 'settings-search-target-remote-devices',
      titleKey: 'cloudSettings.instance.title',
      sectionKey: 'settings.sections.remoteControl',
      descriptionKey: 'cloudSettings.onboarding.subtitle',
      keywordKeys: [
        'cloudSettings.onboarding.claim',
        'cloudSettings.onboarding.initialize',
        'cloudSettings.instance.autoUpdate',
        'cloudSettings.instance.schedule',
      ],
      isVisible: ({ mode, canAccessCloudInstances }) => mode === 'cloud' && canAccessCloudInstances === true,
    },
  ],
} satisfies SettingsSearchModule;
