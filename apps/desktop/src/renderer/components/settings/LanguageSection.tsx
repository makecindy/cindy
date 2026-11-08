/**
 * LanguageSection — Settings 页"显示语言"区块。
 *
 * 语言选项使用单个下拉菜单，避免未来增加语言后设置卡片被横向选项撑开。
 * 文言（及以后其它古典版本）在菜单里只占一项；选中后同一张卡片下方多出一行，
 * 选择字形（简体 / 繁體）与 AI 作答的输出风格。
 */

import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import type { ClassicalReplyStyleId } from '@cindy/maker-shared/classical-reply';
import { classicalStyleOptions, languageSettings } from './LanguageSection.settings-search';
import { SelectParts as Select } from '@/components/ui/select';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';

import { cn } from '@/lib/utils';
import { useLocale } from '@/hooks/useLocale';
import type { LocalePreference } from '@/i18n';
import { isClassicalLocale, type ClassicalLocale } from '../../../shared/locale';

/** The menu's single entry for the classical editions. */
const CLASSICAL_OPTION = 'classical';
type LanguageOption = LocalePreference | typeof CLASSICAL_OPTION;

// 「跟随系统」优先,英语作为第一个显式语言,其余语言按支持列表顺序排列;古典版本合为一项放最后。

const TRIGGER_CLASS = cn(
  'flex h-9 max-w-full shrink-0 items-center justify-between gap-3 rounded-full border px-3.5 text-13 outline-none transition-colors',
  'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
  'hover:bg-[var(--settings-menu-bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
);

interface PillSelectProps<T extends string> {
  'data-setting-id': string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  className: string;
}

function PillSelect<T extends string>({
  'data-setting-id': settingId,
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: PillSelectProps<T>) {
  return (
    <Select.Root value={value} onValueChange={(next) => onChange(next as T)}>
      <Select.Trigger
        data-setting-id={settingId}
        aria-label={ariaLabel}
        className={cn(TRIGGER_CLASS, className)}
      >
        <span className="min-w-0 truncate text-left">
          <Select.Value />
        </span>
        <Select.Icon asChild>
          <ChevronDown
            size={14}
            className="shrink-0 text-[var(--settings-eye-icon)]"
            aria-hidden="true"
          />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          side="bottom"
          align="start"
          sideOffset={6}
          className={cn(
            'z-[10010] max-h-[min(18rem,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl p-2',
            'border border-[var(--settings-input-border)] bg-[var(--settings-theme-card-bg)]',
          )}
        >
          <Select.Viewport className="flex flex-col gap-[2px]">
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                className={cn(
                  'flex h-9 w-full cursor-pointer select-none items-center justify-between gap-3 rounded-[8px] px-3 text-left text-13 outline-none transition-colors',
                  'text-[var(--settings-input-text)]',
                  'data-[state=checked]:text-[var(--settings-menu-text-selected)]',
                )}
              >
                <Select.ItemText className="min-w-0 truncate">{option.label}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check size={16} className="shrink-0 text-[var(--settings-theme-icon-active)]" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

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
            <PillSelect<LanguageOption>
              data-setting-id={languageSettings.language.id}
              value={classical ? CLASSICAL_OPTION : locale}
              options={languageSettings.language.options.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              onChange={chooseLanguage}
              ariaLabel={t('settings.language.ariaLabel')}
              className="w-[320px]"
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
                <PillSelect<ClassicalLocale>
                  data-setting-id={languageSettings.classical.id}
                  value={classical}
                  options={languageSettings.classical.options.map((script) => ({
                    value: script.value,
                    label: t(script.labelKey),
                  }))}
                  onChange={setLocale}
                  ariaLabel={t('settings.language.classical.scriptAriaLabel')}
                  className="w-[112px]"
                />
                <PillSelect<ClassicalReplyStyleId>
                  data-setting-id={languageSettings.classical.id}
                  value={classicalStyle}
                  options={classicalStyleOptions.map((style) => ({
                    value: style.value,
                    label: t(style.labelKey),
                  }))}
                  onChange={setClassicalStyle}
                  ariaLabel={t('settings.language.classical.styleAriaLabel')}
                  className="min-w-0 flex-1"
                />
              </div>
            }
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
