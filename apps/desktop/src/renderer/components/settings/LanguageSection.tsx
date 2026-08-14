/**
 * LanguageSection — Settings 页"显示语言"区块。
 *
 * 语言选项使用单个下拉菜单，避免未来增加语言后设置卡片被横向选项撑开。
 */

import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import * as Select from '@radix-ui/react-select';

import { cn } from '@/lib/utils';
import { useLocale } from '@/hooks/useLocale';
import { SUPPORTED_LOCALES, type LocalePreference } from '@/i18n';

// 「跟随系统」优先,英语作为第一个显式语言,其余语言按支持列表顺序排列。
const LANGUAGE_OPTIONS: ReadonlyArray<LocalePreference> = [
  'system',
  'en',
  ...SUPPORTED_LOCALES.filter((locale) => locale !== 'en'),
];

export function LanguageSection() {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.language.title')}
      </h2>

      <div
        className={cn(
          'flex flex-row items-center justify-between gap-6 rounded-xl p-5',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="min-w-0 flex-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-sublabel)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.language.label')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.language.hint')}
          </p>
        </div>

        <Select.Root value={locale} onValueChange={(value) => setLocale(value as LocalePreference)}>
          <Select.Trigger
            aria-label={t('settings.language.ariaLabel')}
            className={cn(
              'flex h-9 w-[320px] max-w-full shrink-0 items-center justify-between gap-3 rounded-full border px-3.5 text-13 outline-none transition-colors',
              'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
              'hover:bg-[var(--settings-menu-bg-hover)] focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
            )}
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
                'z-[10010] max-h-[18rem] w-[var(--radix-select-trigger-width)] min-w-[220px] overflow-y-auto rounded-xl p-2',
                'border border-[var(--settings-input-border)] bg-[var(--settings-theme-card-bg)]',
                'shadow-[var(--shadow-menu)]',
              )}
            >
              <Select.Viewport className="flex flex-col gap-[2px]">
                {LANGUAGE_OPTIONS.map((opt) => (
                  <Select.Item
                    key={opt}
                    value={opt}
                    className={cn(
                      'flex h-9 w-full cursor-pointer select-none items-center justify-between gap-3 rounded-[8px] px-3 text-left text-13 outline-none transition-colors',
                      'text-[var(--settings-input-text)] data-[highlighted]:bg-[var(--settings-menu-bg-hover)]',
                      'data-[state=checked]:bg-[var(--settings-menu-bg-selected)] data-[state=checked]:font-medium data-[state=checked]:text-[var(--settings-menu-text-selected)]',
                    )}
                  >
                    <Select.ItemText className="min-w-0 truncate">
                      {t(`settings.language.options.${opt}`)}
                    </Select.ItemText>
                    <Select.ItemIndicator>
                      <Check
                        size={16}
                        className="shrink-0 text-[var(--settings-theme-icon-active)]"
                      />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </div>
    </div>
  );
}
