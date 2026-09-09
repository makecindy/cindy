import { useEffect, useState } from 'react';
import { Database, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import { useUpdateBannerDismiss } from '@/hooks/useUpdateBannerDismiss';

const GIB_BYTES = 1024 ** 3;

interface DatabaseSizeWarningBannerProps {
  isCollapsed: boolean;
  onOpenStorage?: () => void;
}

export function DatabaseSizeWarningBanner({
  isCollapsed,
  onOpenStorage,
}: DatabaseSizeWarningBannerProps) {
  const { t } = useTranslation();
  const { status: updateStatus } = useUpdateStatus();
  const { dismissed: updateDismissed } = useUpdateBannerDismiss();
  const [thresholdGiB, setThresholdGiB] = useState(10);
  const [disabled, setDisabled] = useState(false);
  const [databaseBytes, setDatabaseBytes] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI?.localDb?.databaseSizeWarning;
    if (!api) return undefined;

    const refresh = async () => {
      try {
        const [settings, size] = await Promise.all([api.getSettings(), api.getStatus()]);
        if (cancelled) return;
        setThresholdGiB(settings.thresholdGiB);
        setDisabled(settings.disabled);
        setDatabaseBytes(size.databaseBytes);
      } catch {
        // The startup snapshot is optional; keep the banner hidden when it is unavailable.
      }
    };
    void refresh();
    const unsubscribe = api.onChanged?.(() => void refresh());
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const updateHasPriority =
    (updateStatus === 'ready' || updateStatus === 'superseding') && !updateDismissed;
  const shouldShow =
    !isCollapsed &&
    !disabled &&
    !updateHasPriority &&
    databaseBytes !== null &&
    databaseBytes > thresholdGiB * GIB_BYTES;
  if (!shouldShow) return null;

  const handleDisable = async () => {
    try {
      await window.electronAPI.localDb.databaseSizeWarning.setSettings({ disabled: true });
      setDisabled(true);
    } catch {
      // Keep the reminder visible when persistence fails.
    }
  };

  return (
    <div
      className={cn(
        'mx-2 mb-2 flex flex-col gap-2 rounded-xl p-3',
        'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
        'text-[var(--text-primary)]',
      )}
      role="status"
    >
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-[var(--warning-bg-soft)]"
          aria-hidden
        >
          <Database className="h-3.5 w-3.5 text-[var(--warning-fg)]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-12 font-medium leading-[1.35]">
            {t('sidebar.databaseSizeWarning.title')}
          </p>
          <p className="mt-0.5 text-12 leading-[1.35] text-[var(--text-secondary)]">
            {t('sidebar.databaseSizeWarning.description', {
              size: formatBytes(databaseBytes ?? 0),
              threshold: thresholdGiB,
            })}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button
          variant="secondary"
          size="md"
          onClick={() => void handleDisable()}
        >
          {t('sidebar.databaseSizeWarning.disable')}
        </Button>
        <Button
          variant="cta"
          size="md"
          onClick={() => onOpenStorage?.()}
        >
          <Settings2 className="h-3 w-3" aria-hidden />
          {t('sidebar.databaseSizeWarning.openSettings')}
        </Button>
      </div>
    </div>
  );
}
