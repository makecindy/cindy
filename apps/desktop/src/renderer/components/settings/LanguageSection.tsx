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
import '@/components/ui/segmented-control.css';

import { toast } from '@/lib/toast';
import { useLocale } from '@/hooks/useLocale';
import type { LocalePreference } from '@/i18n';
import { isClassicalLocale, type ClassicalLocale } from '../../../shared/locale';

/** The menu's single entry for the classical editions. */
const CLASSICAL_OPTION = 'classical';
type LanguageOption = LocalePreference | typeof CLASSICAL_OPTION;

// 「跟随系统」优先,英语作为第一个显式语言,其余语言按支持列表顺序排列;古典版本合为一项放最后。

export function LanguageSection() {
  const { locale, effectiveLocale, setLocale, classicalStyle, setClassicalStyle } = useLocale();
  return (
    <LanguageSectionView
      locale={locale}
      effectiveLocale={effectiveLocale}
      onChange={setLocale}
      classicalStyle={classicalStyle}
      onClassicalStyleChange={setClassicalStyle}
    />
  );
}

/**
 * The section body for a given preference. The cloud instance settings page renders it
 * for the instance's language; without a style handler the classical style picker is hidden.
 */
export function LanguageSectionView({
  locale,
  effectiveLocale,
  onChange: setLocale,
  classicalStyle,
  onClassicalStyleChange: setClassicalStyle,
  disabled = false,
  locales,
  headingStatus,
}: {
  locale: LocalePreference;
  effectiveLocale?: string;
  /** Local saves report whether they persisted; a cloud target reports its own failures. */
  onChange(next: LocalePreference): boolean | void | Promise<boolean | void>;
  classicalStyle?: ClassicalReplyStyleId;
  onClassicalStyleChange?(next: ClassicalReplyStyleId): void;
  disabled?: boolean;
  /** Languages the target can save; the menu offers only these. */
  locales?: readonly LocalePreference[];
  /** Cloud settings: a group that could not be read says so here, in place of the heading's action. */
  headingStatus?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const classical = isClassicalLocale(locale) ? locale : null;
  const options = languageSettings.language.options.filter(({ value }) =>
    !locales || (value === CLASSICAL_OPTION ? locales.some(isClassicalLocale) : locales.includes(value)),
  );

  const saveLanguage = async (preference: LocalePreference) => {
    if (await setLocale(preference) === false) toast.error(t('regionScreenshot.translation.saveFailed'));
  };

  const chooseLanguage = (option: LanguageOption) => {
    if (option !== CLASSICAL_OPTION) {
      void saveLanguage(option);
      return;
    }
    if (classical) return;
    // First switch keeps the script the user already reads.
    void saveLanguage(effectiveLocale === 'zh-TW' ? 'zh-Hant-x-lzh' : 'zh-Hans-x-lzh');
  };

  return (
    <SettingsSection title={t(languageSettings.language.sectionKey)} action={headingStatus}>
      <SettingsCard>
        <SettingsRow
          wrap
          id={languageSettings.language.targetId}
          className="cindy-segmented-row"
          title={t(languageSettings.language.titleKey)}
          hint={t(languageSettings.language.descriptionKey)}
          trailing={
            <Select
              data-setting-id={languageSettings.language.id}
              value={classical ? CLASSICAL_OPTION : locale}
              options={options.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              onValueChange={(next) => chooseLanguage(next as LanguageOption)}
              label={t('settings.language.ariaLabel')}
              width="md"
              className="shrink-0"
              disabled={disabled}
            />
          }
        />

        {classical ? (
          <SettingsRow
            wrap
            id={languageSettings.classical.targetId}
            className="cindy-segmented-row"
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
                  onValueChange={(next) => { void saveLanguage(next as ClassicalLocale); }}
                  label={t('settings.language.classical.scriptAriaLabel')}
                  width="xs"
                  className="shrink-0"
                  disabled={disabled}
                />
                {classicalStyle && setClassicalStyle ? (
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
                    disabled={disabled}
                  />
                ) : null}
              </div>
            }
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
