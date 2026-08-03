import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import {
  getComposerModifierShortcutLabel,
  useComposerSendShortcutPreference,
} from '@/hooks/useComposerSendShortcutPreference';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';

export function ComposerSendShortcutSection() {
  const { t } = useTranslation();
  const { preference, isCustomized, setPreference } = useComposerSendShortcutPreference();
  const shortcut = getComposerModifierShortcutLabel(window.electronAPI?.platform);

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
              {t('settings.composer.sendShortcut.label', { shortcut })}
            </p>
            <p className="mt-1 text-12 leading-[1.5] text-[var(--text-secondary)]">
              {t('settings.composer.sendShortcut.hint', { shortcut })}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <DefaultOverrideControls isCustomized={isCustomized} onReset={onReset} />
            <Switch
              checked={preference === 'modifier-enter'}
              onCheckedChange={(enabled) => {
                const result = setPreference(enabled ? 'modifier-enter' : 'enter');
                if (!result.ok && result.conflict === 'composer-voice-input') {
                  toast.error(t('settings.shortcuts.errors.composerVoiceConflict'));
                }
              }}
              aria-label={t('settings.composer.sendShortcut.ariaLabel', { shortcut })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
