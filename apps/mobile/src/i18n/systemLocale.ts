/**
 * 系统语言探测(依赖 expo-localization,与纯函数层 locale.ts 分离,
 * 让偏好存储等纯逻辑模块及其测试不用拖 RN 依赖链)。
 */

import { getLocales } from 'expo-localization';

import { resolveSystemLocale, type SupportedLocale } from './locale';

/** 读取当前系统首选语言并解析为支持的 locale。 */
export function detectSystemLocale(): SupportedLocale {
  return resolveSystemLocale(getLocales()[0]?.languageTag);
}
