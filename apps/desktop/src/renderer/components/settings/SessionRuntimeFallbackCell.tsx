import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCcw } from 'lucide-react';

import { Switch } from '@/components/ui/switch';
import { useSessionRuntimeFallback } from '@/hooks/useSessionRuntimeFallback';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('SessionRuntimeFallbackCell');

export function SessionRuntimeFallbackCell() {
  const { t } = useTranslation();
  const { enabled, isCustomized, setEnabled, setIsCustomized } = useSessionRuntimeFallback();
  const [pending, setPending] = useState(false);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const previous = enabled;
      setEnabled(next);
      setPending(true);
      try {
        const settings = await window.electronAPI.maker.sessionRuntimeFallbackSet(next);
        setEnabled(settings.enabled);
        setIsCustomized(settings.isCustomized);
        toast.success(
          t(
            next
              ? 'settings.sessionRuntimeFallback.toast.enabled'
              : 'settings.sessionRuntimeFallback.toast.disabled',
          ),
        );
      } catch (error) {
        log.warn('sessionRuntimeFallbackSet failed', error);
        setEnabled(previous);
        toast.error(
          error instanceof Error
            ? error.message
            : t('settings.sessionRuntimeFallback.toast.toggleFailed'),
        );
      } finally {
        setPending(false);
      }
    },
    [enabled, setEnabled, setIsCustomized, t],
  );

  const handleReset = useCallback(async () => {
    setPending(true);
    try {
      const settings = await window.electronAPI.maker.sessionRuntimeFallbackReset();
      setEnabled(settings.enabled);
      setIsCustomized(settings.isCustomized);
      toast.success(t('settings.defaults.restored'));
    } catch (error) {
      log.warn('sessionRuntimeFallbackReset failed', error);
      toast.error(error instanceof Error ? error.message : t('settings.defaults.restoreFailed'));
    } finally {
      setPending(false);
    }
  }, [setEnabled, setIsCustomized, t]);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-[14px]">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            'bg-[var(--settings-input-bg)]',
          )}
        >
          <RefreshCcw size={18} className="text-[var(--settings-section-title)]" />
        </div>
        <div className="flex flex-col gap-[8px]">
          <p className="text-14 font-medium leading-none text-[var(--settings-section-title)]">
            {t('settings.sessionRuntimeFallback.cell.label')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-desc)]">
            {t('settings.sessionRuntimeFallback.cell.description')}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <DefaultOverrideControls
          isCustomized={isCustomized}
          disabled={pending}
          onReset={() => void handleReset()}
        />
        <Switch
          checked={enabled}
          disabled={pending}
          onCheckedChange={(value) => void handleToggle(value)}
          aria-label={t('settings.sessionRuntimeFallback.toggleAria')}
        />
      </div>
    </div>
  );
}
