/**
 * 移动端 locale 常量与解析纯函数(与 desktop shared/locale.ts 同一 4 语主干)。
 *
 * 本模块保持零依赖(不 import expo / RN):偏好存储及其测试直接消费,
 * 读系统语言的 detectSystemLocale 在 systemLocale.ts。
 * 解析规则与 loginMessages.resolveLoginLocale 保持一致:中文(含 Hans/Hant/TW/HK/MO)
 * 一律并进 zh-CN(无繁体 catalog),ja / ko 前缀直取,其余兜底 en。
 * 刻意用字符串前缀而非 Intl.Locale——Hermes 的 Intl 子集在各版本间能力不齐,
 * 前缀匹配对 4 语主干足够且行为可预期。
 */

/** UI 支持的具体语言。 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en', 'ja', 'ko'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** 用户偏好:'system' = 跟随系统语言,由本模块在运行时解析。 */
export type LocalePreference = SupportedLocale | 'system';

/** 缺 key / 无法解析系统语言时的回退语言(与 desktop 一致)。 */
export const DEFAULT_LOCALE: SupportedLocale = 'en';

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || isSupportedLocale(value);
}

/** BCP 47 languageTag → 支持的 locale。大小写不敏感,null/undefined 兜底 en。 */
export function resolveSystemLocale(
  languageTag: string | null | undefined,
): SupportedLocale {
  const tag = languageTag?.toLowerCase() ?? '';
  if (tag.startsWith('zh')) return 'zh-CN';
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('ko')) return 'ko';
  return DEFAULT_LOCALE;
}
