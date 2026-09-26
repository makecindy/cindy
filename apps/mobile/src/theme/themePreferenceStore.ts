/**
 * 显示模式偏好存储(AsyncStorage,版本化 key)。
 *
 * 遵循「默认 + override」模型(docs/dev-rules/configuration-and-overrides.md),与
 * 显示语言偏好同构:只持久化用户显式选择的「浅色 / 深色」;「跟随系统」是没有
 * override 这个状态本身——恢复跟随系统 = 删除存储项。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ThemeMode } from './tokens';

export type ThemePreference = 'system' | ThemeMode;

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

const STORAGE_KEY = 'cindy.mobile.theme-preference.v1';

function isThemeOverride(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

/** 有效模式 = 用户 override ?? 系统外观(系统未报告时按浅色)。 */
export function resolveThemeMode(
  preference: ThemePreference,
  systemScheme: string | null | undefined,
): ThemeMode {
  if (preference !== 'system') return preference;
  return systemScheme === 'dark' ? 'dark' : 'light';
}

/** 读失败按「跟随系统」处理:启动不能因为本机存储异常卡住。 */
export async function readThemePreference(): Promise<ThemePreference> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  return isThemeOverride(raw) ? raw : 'system';
}

/** 写失败向上抛出:调用方需告知用户这次选择没有保存,不能把未落盘的选择当成已保存。 */
export async function saveThemePreference(preference: ThemePreference): Promise<void> {
  if (preference === 'system') {
    await AsyncStorage.removeItem(STORAGE_KEY);
    return;
  }
  await AsyncStorage.setItem(STORAGE_KEY, preference);
}

export const __testing = {
  storageKey: STORAGE_KEY,
};
