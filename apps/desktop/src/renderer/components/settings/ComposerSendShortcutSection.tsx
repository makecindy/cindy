import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import * as Select from '@radix-ui/react-select';

import { cn } from '@/lib/utils';
import {
  getComposerModifierShortcutLabel,
  useComposerSendShortcutPreference,
  type ComposerSendShortcutPreference,
} from '@/hooks/useComposerSendShortcutPreference';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';

// 默认挡在前;多行挡是「单行 Enter 直发、多行 Enter 换行」的折中挡,排中间。
const SHORTCUT_OPTIONS: ReadonlyArray<ComposerSendShortcutPreference> = [
  'enter',
  'modifier-enter-multiline',
  'modifier-enter',
];

export function ComposerSendShortcutSection() {
  const { t } = useTranslation();
  const { preference, isCustomized, setPreference } = useComposerSendShortcutPreference();
  const shortcut = getComposerModifierShortcutLabel(window.electronAPI?.platform);

  const onSelect = useCallback(
    (value: string) => {
      const result = setPreference(value as ComposerSendShortcutPreference);
      if (!result.ok && result.conflict === 'composer-voice-input') {
        toast.error(t('settings.shortcuts.errors.composerVoiceConflict'));
      }
    },
    [setPreference, t],
  );

  const onReset = useCallback(() => {
    setPreference('enter');
    toast.success(t('settings.defaults.restored'));
  }, [setPreference, t]);

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.composer.title')}
        </h2>
      </div>

      <div className="flex flex-col gap-[14px] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-14 font-medium leading-[1.3] text-[var(--text-primary)]">
              {t('settings.composer.sendShortcut.label')}
            </p>
            <p className="mt-1 text-12 leading-[1.5] text-[var(--text-secondary)]">
              {t('settings.composer.sendShortcut.hint')}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <DefaultOverrideControls isCustomized={isCustomized} onReset={onReset} />
            <Select.Root value={preference} onValueChange={onSelect}>
              <Select.Trigger
                aria-label={t('settings.composer.sendShortcut.ariaLabel')}
                className={cn(
                  'flex h-9 w-[280px] max-w-full shrink-0 items-center justify-between gap-3 rounded-full border px-3.5 text-13 outline-none transition-colors',
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
                    // DESIGN.md §4 Select & Dropdown:面板不带阴影,分层靠 Card 底色 + 边框。
                    // (LanguageSection 的 shadow 是先于该条款的存量,不复制进新代码。)
                    'z-[10010] max-h-[18rem] w-[var(--radix-select-trigger-width)] min-w-[220px] overflow-y-auto rounded-xl p-2',
                    'border border-[var(--settings-input-border)] bg-[var(--settings-theme-card-bg)]',
                  )}
                >
                  <Select.Viewport className="flex flex-col gap-[2px]">
                    {SHORTCUT_OPTIONS.map((opt) => (
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
                          {t(`settings.composer.sendShortcut.options.${opt}`, { shortcut })}
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
      </div>
    </div>
  );
}
