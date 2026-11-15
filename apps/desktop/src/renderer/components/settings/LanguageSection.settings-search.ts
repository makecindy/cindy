import { CLASSICAL_REPLY_STYLES, replyStyleFamilyOf } from '@cindy/maker-shared/classical-reply';
import { SUPPORTED_LOCALES, isClassicalLocale, type LocalePreference, type SupportedLocale } from '../../../shared/locale';
import { effectiveOf } from '../../lib/localePreference';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

export const classicalStyleOptions = CLASSICAL_REPLY_STYLES.lzh.map((style) => ({
  value: style.id,
  labelKey: `settings.language.classical.styles.${style.id}`,
}));

export const languageSettings = defineSettings({
  language: {
    id: 'general.displayLanguage',
    tab: 'general',
    targetId: 'settings-language',
    fallbackTargetId: 'settings-search-target-general-language',
    titleKey: 'settings.language.label',
    descriptionKey: 'settings.language.hint',
    sectionKey: 'settings.language.title',
    options: (
      [
        'system',
        'en',
        ...SUPPORTED_LOCALES.filter((locale) => locale !== 'en' && !isClassicalLocale(locale)),
        'classical',
      ] as const
    ).map((value) => ({
      value,
      labelKey: `settings.language.options.${value}`,
    })),
  },
  classical: {
    id: 'general.classicalLanguage',
    isVisible: ({ locale }) => isClassicalLocale(locale),
    tab: 'general',
    targetId: 'settings-classical-language',
    fallbackTargetId: 'settings-language',
    titleKey: 'settings.language.classical.label',
    descriptionKey: 'settings.language.classical.hint',
    sectionKey: 'settings.language.title',
    options: [
      { value: 'zh-Hans-x-lzh', labelKey: 'settings.language.classical.script.hans' },
      { value: 'zh-Hant-x-lzh', labelKey: 'settings.language.classical.script.hant' },
    ],
    keywordKeys: classicalStyleOptions.map(({ labelKey }) => labelKey),
  },
  replyStyle: {
    id: 'general.replyStyle',
    // 简体中文 / 繁體中文界面的「AI 作答文风」行:与渲染行同口径——存储偏好按生效
    // 语言解析(跟随系统时取 OS 语言)，文言界面该行不存在、由 classical 条目负责。
    isVisible: ({ locale }) => {
      if (!locale || isClassicalLocale(locale)) return false;
      const pref: LocalePreference = (SUPPORTED_LOCALES as readonly string[]).includes(locale)
        ? (locale as SupportedLocale)
        : 'system';
      return replyStyleFamilyOf(effectiveOf(pref)) !== null;
    },
    tab: 'general',
    targetId: 'settings-reply-style',
    fallbackTargetId: 'settings-language',
    titleKey: 'settings.language.classical.styleAriaLabel',
    sectionKey: 'settings.language.title',
    keywordKeys: classicalStyleOptions.map(({ labelKey }) => labelKey),
  },
});

export default {
  id: 'language',
  order: 30,
  entries: Object.values(languageSettings),
} satisfies SettingsSearchModule;
