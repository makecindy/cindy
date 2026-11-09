/**
 * LanguageSection — Settings 页"显示语言"区块。
 *
 * 语言选项使用单个下拉菜单，避免未来增加语言后设置卡片被横向选项撑开。
 * 文言（及以后其它古典版本）在菜单里只占一项；选中后同一张卡片下方多出一行，
 * 选择字形（简体 / 繁體）与 AI 作答的输出风格。
 */

import { useTranslation } from 'react-i18next';
import type { ClassicalReplyStyleId } from '@cindy/maker-shared/classical-reply';
import { classicalStyleOptions, languageSettings } from './LanguageSection.settings-search';
import { Select } from '@/components/ui/select';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';

import { useLocale } from '@/hooks/useLocale';
import type { LocalePreference } from '@/i18n';
import { isClassicalLocale, type ClassicalLocale } from '../../../shared/locale';

/** The menu's single entry for the classical editions. */
const CLASSICAL_OPTION = 'classical';
type LanguageOption = LocalePreference | typeof CLASSICAL_OPTION;

// 「跟随系统」优先,英语作为第一个显式语言,其余语言按支持列表顺序排列;古典版本合为一项放最后。

export function LanguageSection() {
  const { t } = useTranslation();
  const { locale, effectiveLocale, setLocale, classicalStyle, setClassicalStyle } = useLocale();
  const classical = isClassicalLocale(locale) ? locale : null;

  const chooseLanguage = (option: LanguageOption) => {
    if (option !== CLASSICAL_OPTION) {
      setLocale(option);
      return;
    }
    if (classical) return;
    // First switch keeps the script the user already reads.
    setLocale(effectiveLocale === 'zh-TW' ? 'zh-Hant-x-lzh' : 'zh-Hans-x-lzh');
  };

  return (
    <SettingsSection title={t(languageSettings.language.sectionKey)}>
      <SettingsCard>
        <SettingsRow
          id={languageSettings.language.targetId}
          title={t(languageSettings.language.titleKey)}
          hint={t(languageSettings.language.descriptionKey)}
          trailing={
            <Select
              data-setting-id={languageSettings.language.id}
              value={classical ? CLASSICAL_OPTION : locale}
              options={languageSettings.language.options.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              onValueChange={(next) => chooseLanguage(next as LanguageOption)}
              label={t('settings.language.ariaLabel')}
              width="md"
              className="shrink-0"
            />
          }
        />

        {classical ? (
          <SettingsRow
            id={languageSettings.classical.targetId}
            title={t(languageSettings.classical.titleKey)}
            hint={t(languageSettings.classical.descriptionKey)}
            trailing={
              <div className="flex w-[320px] max-w-full shrink-0 flex-row gap-2">
                <Select
                  data-setting-id={languageSettings.classical.id}
                  value={classical}
                  options={languageSettings.classical.options.map((script) => ({
                    value: script.value,
                    label: t(script.labelKey),
                  }))}
                  onValueChange={(next) => setLocale(next as ClassicalLocale)}
                  label={t('settings.language.classical.scriptAriaLabel')}
                  className="w-[112px] shrink-0"
                />
                <Select
                  data-setting-id={languageSettings.classical.id}
                  value={classicalStyle}
                  options={classicalStyleOptions.map((style) => ({
                    value: style.value,
                    label: t(style.labelKey),
                  }))}
                  onValueChange={(next) => setClassicalStyle(next as ClassicalReplyStyleId)}
                  label={t('settings.language.classical.styleAriaLabel')}
                  className="flex-1"
                />
              </div>
            }
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
