import { getLocales } from 'expo-localization';

import { getManualLocaleOverride } from '@/i18n/appLanguage';

export type NewSessionLocale = 'zh-CN' | 'en' | 'ja' | 'ko';

const messages = {
  'zh-CN': {
    showHiddenDirectories: '显示隐藏文件夹',
    emptyDirectory: '没有可显示的子目录。',
  },
  en: {
    showHiddenDirectories: 'Show Hidden Folders',
    emptyDirectory: 'No folders to show.',
  },
  ja: {
    showHiddenDirectories: '隠しフォルダを表示',
    emptyDirectory: '表示できるサブフォルダはありません。',
  },
  ko: {
    showHiddenDirectories: '숨김 폴더 표시',
    emptyDirectory: '표시할 하위 폴더가 없습니다.',
  },
} as const;

export type NewSessionMessageKey = keyof (typeof messages)['zh-CN'];

export const newSessionMessages: Record<
  NewSessionLocale,
  Record<NewSessionMessageKey, string>
> = messages;

/** 将系统语言映射到新建会话界面支持的 4 种语言，未覆盖语言回退英文。 */
export function resolveNewSessionLocale(
  languageTag: string | null | undefined,
): NewSessionLocale {
  const tag = languageTag?.toLowerCase() ?? '';
  if (tag.startsWith('zh')) return 'zh-CN';
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('ko')) return 'ko';
  return 'en';
}

export function newSessionText(key: NewSessionMessageKey): string {
  // 设置里的手动语言选择优先,未选择时跟随系统语言。
  const locale =
    getManualLocaleOverride() ?? resolveNewSessionLocale(getLocales()[0]?.languageTag);
  return newSessionMessages[locale][key];
}
