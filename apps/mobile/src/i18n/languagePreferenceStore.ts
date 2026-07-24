/**
 * 显示语言偏好存储(AsyncStorage,版本化 key)。
 *
 * 遵循「默认 + override」模型(docs/dev-rules/configuration-and-overrides.md):
 * 只持久化用户显式选择的具体语言;「跟随系统」不是一条被写死的值,而是
 * 「没有 override」这个状态本身——恢复跟随系统 = 删除存储项。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { isSupportedLocale, type LocalePreference } from './locale';

const STORAGE_KEY = 'xdt-maker.mobile.language-preference.v1';

export async function readLanguagePreference(): Promise<LocalePreference> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  return isSupportedLocale(raw) ? raw : 'system';
}

export async function saveLanguagePreference(
  preference: LocalePreference,
): Promise<void> {
  if (preference === 'system') {
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
    return;
  }
  await AsyncStorage.setItem(STORAGE_KEY, preference).catch(() => undefined);
}

export const __testing = {
  storageKey: STORAGE_KEY,
};
