import { additionalSettings } from './AdditionalSettings.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';

import { SettingsRow } from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import { useSilentEncryptedRetry } from '@/hooks/useSilentEncryptedRetry';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('SilentEncryptedRetryCell');

export function SilentEncryptedRetryCell() {
  const setting = useSettingDefinition(additionalSettings.silentRetry);
  const { t } = useTranslation();
  const { enabled, isCustomized, setEnabled, setIsCustomized } = useSilentEncryptedRetry();
  const [pending, setPending] = useState(false);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const prev = enabled;
      setEnabled(next);
      setPending(true);
      try {
        const settings = await window.electronAPI.maker.silentEncryptedRetrySet(next);
        setEnabled(settings.enabled);
        setIsCustomized(settings.isCustomized);
        toast.success(
          t(
            next
              ? 'settings.silentEncryptedRetry.toast.enabled'
              : 'settings.silentEncryptedRetry.toast.disabled',
          ),
        );
      } catch (err) {
        log.warn('silentEncryptedRetrySet failed', err);
        toast.error(
          err instanceof Error ? err.message : t('settings.silentEncryptedRetry.toast.toggleFailed'),
        );
        setEnabled(prev);
      } finally {
        setPending(false);
      }
    },
    [enabled, setEnabled, setIsCustomized, t],
  );

  const handleReset = useCallback(async () => {
    setPending(true);
    try {
      const next = await window.electronAPI.maker.silentEncryptedRetryReset();
      setEnabled(next.enabled);
      setIsCustomized(next.isCustomized);
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      log.warn('silentEncryptedRetryReset failed', err);
      toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
    } finally {
      setPending(false);
    }
  }, [setEnabled, setIsCustomized, t]);

  return (
    <SettingsRow
      {...setting.anchorProps}
      lead={
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            'bg-[var(--settings-input-bg)]',
          )}
        >
          <ShieldAlert size={18} className="text-[var(--settings-section-title)]" />
        </span>
      }
      title={setting.title}
      hint={setting.description}
      trailing={
        <div className="flex items-center gap-2">
          <DefaultOverrideControls
            isCustomized={isCustomized}
            disabled={pending}
            onReset={() => void handleReset()}
          />
          <Switch
            {...setting.controlProps}
            checked={enabled}
            disabled={pending}
            onCheckedChange={(v) => void handleToggle(v)}
            aria-label={t('settings.silentEncryptedRetry.toggleAria')}
          />
        </div>
      }
    />
  );
}
