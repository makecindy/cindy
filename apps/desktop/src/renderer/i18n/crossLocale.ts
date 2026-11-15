/**
 * 不依赖语言包是否已加载、可在任一语言下同步读取的少量文案。
 *
 * 语言包按需加载后，`t(key, { lng })` 只对已加载的语言有效。需要跨语言比对或搜索的功能
 * 改读这张表；收录哪些 key 由 scripts/i18n-cross-locale.mjs 决定并生成，`pnpm check:i18n`
 * 校验它与各语言 common.json 一致。表里没有的 key 返回 undefined。
 */

import type { SupportedLocale } from '../../shared/locale';
import crossLocaleStrings from './crossLocaleStrings.generated.json';

const table: Partial<Record<string, Record<string, string>>> = crossLocaleStrings;

export function getCrossLocaleString(locale: SupportedLocale, key: string): string | undefined {
  return table[locale]?.[key];
}
