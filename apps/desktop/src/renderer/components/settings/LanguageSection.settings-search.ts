import { CLASSICAL_REPLY_STYLES } from '@cindy/maker-shared/classical-reply';
import { SUPPORTED_LOCALES, isClassicalLocale } from '../../../shared/locale';
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
});

export default {
  id: 'language',
  order: 30,
  entries: Object.values(languageSettings),
} satisfies SettingsSearchModule;
