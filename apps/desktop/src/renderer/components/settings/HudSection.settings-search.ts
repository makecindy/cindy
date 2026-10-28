import type { SettingsSearchModule } from './settingsSearchTypes';
export default {
  id: 'HudSection',
  order: 35,
  entries: [
    {
      id: 'hud.settings',
      tab: 'hud',
      isVisible: ({ platform }) => platform === 'darwin',
      targetId: 'settings-hud',
      titleKey: 'hud.settings',
      sectionKey: 'hud.settings',
      descriptionKey: 'hud.description',
      aliases: ['HUD', '透明度', '置顶', '屏幕', 'opacity', 'transparency', 'screen', '鼠标穿透', 'click through', '快捷键', 'shortcut'],
    },
  ],
} satisfies SettingsSearchModule;
