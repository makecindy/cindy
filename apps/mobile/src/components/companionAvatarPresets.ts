/**
 * 伙伴预设头像的本地资源。设置页的头像、对话里的头像和桌面入口组件共用这一份映射，
 * 新增预设时只改这里。
 */
export const COMPANION_AVATAR_PRESETS: Record<string, number> = {
  'cindy://avatar/preset/cindy': require('../../assets/bot-presets/cindy.png'),
  'cindy://avatar/preset/dash': require('../../assets/bot-presets/dash.png'),
  'cindy://avatar/preset/lizi': require('../../assets/bot-presets/lizi.png'),
};

export function companionAvatarPreset(value: string): number | null {
  return COMPANION_AVATAR_PRESETS[value] ?? null;
}
