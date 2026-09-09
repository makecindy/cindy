import { useTranslation } from 'react-i18next';

export interface DownloadMeterProgress {
  label: string;
  percent?: number | null;
  completed?: number;
  total?: number;
  bytesPerSecond?: number;
  error?: boolean;
  paused?: boolean;
}

export function formatDownloadBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return kb >= 10 ? `${Math.round(kb)} KB` : `${Math.max(kb, 0.1).toFixed(1)} KB`;
}

export function formatDownloadSpeed(bytesPerSecond?: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '';
  const suffix = '/s';
  const formatted = formatDownloadBytes(bytesPerSecond);
  return formatted ? `${formatted}${suffix}` : '';
}

export function downloadPercent(progress: {
  percent?: number | null;
  completed?: number;
  total?: number;
}): number | null {
  if (progress.percent != null) return Math.min(100, Math.max(0, progress.percent));
  if (progress.total && progress.total > 0) {
    return Math.min(100, Math.round(((progress.completed ?? 0) / progress.total) * 100));
  }
  return null;
}

export function DownloadMeter({ progress }: { progress: DownloadMeterProgress }) {
  const { t } = useTranslation();
  const percent = downloadPercent(progress);
  const bytesLabel =
    progress.completed != null && progress.total != null && progress.total > 0
      ? t('settings.providers.local.pullBytes', {
          done: formatDownloadBytes(progress.completed),
          total: formatDownloadBytes(progress.total),
        })
      : null;
  const speedLabel =
    !progress.paused && progress.bytesPerSecond && progress.bytesPerSecond > 0
      ? formatDownloadSpeed(progress.bytesPerSecond)
      : null;

  return (
    <div className="flex flex-col gap-1.5" role="status">
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={progress.error ? 'text-12 leading-snug' : 'truncate text-12'}
          style={{ color: progress.error ? 'var(--error-flat)' : 'var(--text-secondary)' }}
        >
          {progress.label}
        </span>
        {percent != null ? (
          <span className="shrink-0 text-12 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
            {percent}%
          </span>
        ) : progress.error ? null : (
          <span className="shrink-0 text-12 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.providers.local.pullIndeterminate')}
          </span>
        )}
      </div>
      <div
        className="h-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label={progress.label}
        style={{ backgroundColor: 'var(--surface-chip)' }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-150"
          style={{
            width: `${percent ?? 0}%`,
            backgroundColor: progress.error ? 'var(--remote-status-failed)' : 'var(--text-primary)',
          }}
        />
      </div>
      {(bytesLabel || speedLabel) && (
        <div
          className="flex items-baseline justify-between gap-3 text-11 tabular-nums"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <span className="min-w-0 truncate">{bytesLabel}</span>
          {speedLabel ? <span className="shrink-0">{speedLabel}</span> : null}
        </div>
      )}
    </div>
  );
}
