import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import {
  getComposerModifierShortcutLabel,
  useComposerSendShortcutPreference,
} from '@/hooks/useComposerSendShortcutPreference';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

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
      <h2 className={SETTINGS_SECTION_TITLE_CLASS}>{t('settings.composer.title')}</h2>

      <div className={SETTINGS_CARD_CLASS}>
        <div className={SETTINGS_ROW_CLASS}>
          <div className="flex min-w-0 flex-col gap-1">
            <p className={SETTINGS_ROW_LABEL_CLASS} style={{ letterSpacing: '0.12px' }}>
              {t('settings.composer.sendShortcut.label', { shortcut })}
            </p>
            <p className={SETTINGS_ROW_HINT_CLASS}>
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
