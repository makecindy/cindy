import { manageAppPreferences } from './preferences.js';
import { readAppearanceSettingsState } from '../appearance-settings-store.js';
import { updateAppearanceFromSettings, resetAppearanceFromSettings } from '../appearance-settings-ipc.js';
import { readGitSafetySettingsState, writeGitSafetyMode, resetGitSafetySettings } from '../maker-host/git-safety-settings-store.js';
import { readGoalSettingsState, writeGoalSettings, resetGoalSettings } from '../maker-host/goal-settings-store.js';
import { readAgentResourceSettingsState, writeAgentResourceSetting, resetAgentResourceSettings } from '../maker-host/agent-resource-settings-store.js';
import { notifyAppSettingsChanged } from './changes.js';
import { runtimeSettingsSections } from './runtime.js';
import { pluginSettingsSections } from './plugins.js';
import { appPreferenceSchema } from '../../shared/appPreferenceControl.js';
import { z } from 'zod';
import { APP_ICONS, APPEARANCE_LIMITS, WALLPAPER_IDS } from '../../shared/appearanceSettings.js';
import { createAppSettingsService, type AppSettingsSection } from './service.js';

const numberIn = (range: { min: number; max: number }) => z.number().min(range.min).max(range.max);

/** Shared host operations; discovery only serializes their registered metadata. */
export const appSettingsSections: AppSettingsSection[] = [{
  id: 'preferences', title: '语言、主题与使用偏好',
  description: '界面语言、明暗主题、主题家族、通知、发送快捷键、链接打开方式、流式动效、消息导航、文件显示和首页偏好。', effective: 'immediate',
  schema: appPreferenceSchema,
  read: async () => manageAppPreferences('get'),
  update: async patch => manageAppPreferences('update', patch),
}, {
  id: 'appearance', title: '外观、字体与壁纸',
  description: '界面、代码、终端字体和字号，窗口缩放，壁纸及动态效果，macOS Dock 图标。', effective: 'immediate',
  schema: z.strictObject({
    uiFamily: z.string().max(256).optional(), codeFamily: z.string().max(256).optional(),
    terminalFamily: z.string().max(256).optional(), uiSize: numberIn(APPEARANCE_LIMITS.uiSize).optional(),
    codeSize: numberIn(APPEARANCE_LIMITS.codeSize).optional(), terminalSize: numberIn(APPEARANCE_LIMITS.terminalSize).optional(),
    windowZoom: numberIn(APPEARANCE_LIMITS.windowZoom).optional(), wallpaperId: z.enum(WALLPAPER_IDS).optional(),
    wallpaperOverlay: numberIn(APPEARANCE_LIMITS.wallpaperOverlay).optional(),
    wallpaperVisibility: numberIn(APPEARANCE_LIMITS.wallpaperVisibility).nullable().optional(),
    wallpaperBlur: numberIn(APPEARANCE_LIMITS.wallpaperBlur).nullable().optional(),
    wallpaperMotion: z.enum(['static', 'dynamic']).optional(),
    appIcon: z.enum(APP_ICONS).optional(),
  }),
  read: async () => {
    const state = readAppearanceSettingsState();
    const value = { ...state.value };
    const defaults = { ...state.defaults };
    delete value.customWallpaperUrl;
    delete defaults.customWallpaperUrl;
    return { ...state, value, defaults };
  },
  update: async patch => { await updateAppearanceFromSettings(patch); },
  reset: async () => { await resetAppearanceFromSettings(); },
}, {
  id: 'git-safety', title: 'Git 安全快照', description: '关闭、仅现有 Git 项目或所有项目自动快照。', effective: 'next-turn',
  schema: z.strictObject({ mode: z.enum(['off', 'existing-git', 'all-projects']).optional() }),
  read: async () => readGitSafetySettingsState(),
  update: async patch => writeGitSafetyMode(patch.mode as 'off' | 'existing-git' | 'all-projects'),
  reset: async () => resetGitSafetySettings(),
}, {
  id: 'goal-defaults', title: '目标模式默认限制', description: '以后启动目标模式的轮数、token 预算和无进展轮数；null 为不限。', effective: 'new-goals',
  schema: z.strictObject({ maxTurns: z.number().int().positive().nullable().optional(),
    budgetTokens: z.number().int().positive().nullable().optional(), noProgressLimit: z.number().int().positive().nullable().optional() }),
  read: async () => readGoalSettingsState(),
  update: async patch => writeGoalSettings(patch),
  reset: async () => resetGoalSettings(),
}, {
  id: 'agent-resources', title: '运行资源', description: '命令并发、进程优先级和工具链线程限制；并发 0 为不限。恢复 normal 仅作用于新进程。', effective: 'new-commands-and-processes',
  schema: z.strictObject({ maxConcurrentCommands: z.number().int().min(0).max(64).optional(),
    processPriority: z.enum(['normal', 'low', 'lowest']).optional(), capToolchainThreads: z.boolean().optional() }),
  read: async () => readAgentResourceSettingsState(),
  update: async patch => {

    for (const [key, value] of Object.entries(patch)) writeAgentResourceSetting(
      key as keyof import('../maker-host/agent-resource-settings-store.js').AgentResourceSettings,
      value as number | boolean | 'normal' | 'low' | 'lowest');
  },
  reset: async () => resetAgentResourceSettings(),
}];

export const manageAppSettings: ReturnType<typeof createAppSettingsService> = async (input, assertCurrent) => {
  const result = await createAppSettingsService([...appSettingsSections, ...runtimeSettingsSections(), ...pluginSettingsSections()])(input, assertCurrent);
  if ((input.operation === 'update' || input.operation === 'reset') && !('errorCode' in result)) {
    await assertCurrent();
    // Plugin KV publishes the same event for every write path, including /kv.
    if (!input.section?.startsWith('plugins.')) notifyAppSettingsChanged(input.section!);
  }
  return result;
};
