import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { DownloadProgress } from '../../../shared/downloadProgress';
import { modernLocaleOf, type SupportedLocale } from '../../../shared/locale';

/**
 * The standard download/install progress for every Desktop surface (DESIGN.md §4
 * 「Download progress」). Feed it the shared `DownloadProgress` built in Main by
 * `createDownloadProgressReporter`; do not draw another bar or format bytes locally.
 *
 *   label ................................ 42%
 *   ███████████████░░░░░░░░░░░░░░░░░░░░░░░░░
 *   12.3 MB / 29 MB              1.2 MB/s · 14s left
 *
 * The second line explains every non-transfer state (retrying and why, verifying,
 * installing, paused), so a bar that stops moving never looks frozen. Actions such as
 * cancel or pause stay with the surface.
 */
export interface DownloadMeterProps {
  label: string;
  progress: DownloadProgress;
  /** Failure text. Shown in place of the status line; the bar turns to the error color. */
  error?: string | null;
}

export function formatDownloadBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return kb >= 10 ? `${Math.round(kb)} KB` : `${Math.max(kb, 0.1).toFixed(1)} KB`;
}

export function formatDownloadSpeed(bytesPerSecond?: number | null): string {
  const formatted = formatDownloadBytes(bytesPerSecond);
  return formatted ? `${formatted}/s` : '';
}

/** Whole percent for labels; only a finished transfer reads 100%. */
export function downloadPercentLabel(percent: number | null): number | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  return percent >= 100 ? 100 : Math.min(99, Math.max(0, Math.round(percent)));
}

/** "14s", "3m 20s", "25m", "1h 5m" in the reader's language. */
export function formatDownloadEta(seconds: number, locale: string): string {
  const total = Math.max(1, Math.round(seconds));
  const parts: Array<[number, 'hour' | 'minute' | 'second']> =
    total >= 3600
      ? [
          [Math.floor(total / 3600), 'hour'],
          [Math.round((total % 3600) / 60), 'minute'],
        ]
      : total >= 600
        ? [[Math.round(total / 60), 'minute']]
        : total >= 60
          ? [
              [Math.floor(total / 60), 'minute'],
              [total % 60, 'second'],
            ]
          : [[total, 'second']];
  return parts
    .filter(([value], index) => index === 0 || value > 0)
    .map(([value, unit]) =>
      new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value),
    )
    .join(' ');
}

/** The status line and the figures beside it, shared by the bar and the ring. */
function useDownloadText(progress: DownloadProgress, error?: string | null) {
  const { t, i18n } = useTranslation();
  const transferring = progress.phase === 'downloading';

  let status: string;
  if (error) status = error;
  else if (progress.phase === 'retrying')
    status = t(`downloadProgress.retry.${progress.retryReason ?? 'network'}`);
  else if (transferring)
    status =
      progress.total !== null && progress.total > 0
        ? t('downloadProgress.bytes', {
            done: formatDownloadBytes(progress.loaded) || '0 KB',
            total: formatDownloadBytes(progress.total),
          })
        : formatDownloadBytes(progress.loaded);
  else status = t(`downloadProgress.phase.${progress.phase}`);

  const detail: string[] = [];
  if (transferring && progress.speedBps > 0) {
    detail.push(formatDownloadSpeed(progress.speedBps));
    if (progress.etaSeconds !== null) {
      const locale = modernLocaleOf((i18n?.language ?? 'en') as SupportedLocale);
      detail.push(
        t('downloadProgress.eta', { time: formatDownloadEta(progress.etaSeconds, locale) }),
      );
    }
  }
  if (progress.phase === 'retrying' && progress.attempt)
    detail.push(t('downloadProgress.attempt', { attempt: progress.attempt }));
  return { status, detail };
}

export function DownloadMeter({ label, progress, error }: DownloadMeterProps) {
  const failed = Boolean(error) || progress.phase === 'failed';
  const percent = downloadPercentLabel(progress.percent);
  const { status, detail } = useDownloadText(progress, error);

  return (
    <div className="flex flex-col gap-1.5" role="status">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-12" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </span>
        {percent !== null && !failed ? (
          <span className="shrink-0 text-12 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
            {percent}%
          </span>
        ) : null}
      </div>
      <div
        className="h-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={[status, ...detail].filter(Boolean).join(' · ') || undefined}
        aria-label={label}
        style={{ backgroundColor: 'var(--surface-chip)' }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-[var(--motion-fast)]"
          style={{
            width: `${percent ?? 0}%`,
            backgroundColor: failed ? 'var(--remote-status-failed)' : 'var(--text-primary)',
          }}
        />
      </div>
      {status || detail.length ? (
        <div
          className="flex items-baseline justify-between gap-3 text-11 tabular-nums"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <span
            className={failed ? 'min-w-0 leading-snug' : 'min-w-0 truncate'}
            style={failed ? { color: 'var(--error-flat)' } : undefined}
          >
            {status}
          </span>
          {detail.length ? <span className="shrink-0">{detail.join(' · ')}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

const RING_STROKE = 2.5;

export interface DownloadRingProps {
  /** What is being downloaded or installed; read by screen readers, not drawn. */
  label: string;
  progress: DownloadProgress;
  /** Outer diameter in px. 20 matches the app's other ring (ContextCapacityRing). */
  size?: 16 | 20 | 24;
  /**
   * Words beside the ring. Defaults to the step ("Downloading…", "Installing…"); a surface passes
   * its own for states the downloader cannot name, such as waiting for a confirmation or "Updated".
   */
  status?: string;
  /** Say why a retry is happening instead of the short "Retrying…"; for surfaces with room. */
  explainRetry?: boolean;
  /**
   * More about the state than the words beside the ring have room for, such as why it failed.
   * Shown on hover and read by screen readers.
   */
  note?: string;
  /** Text size and color of the words, when the surface needs a different tier. */
  className?: string;
}

/**
 * The compact form of the standard progress, for a slot the size of a button (DESIGN.md §4
 * 「Download progress」). The ring carries how much has arrived and the words carry the step; no
 * figures are drawn. Exact bytes, speed and time left stay available to screen readers through
 * `aria-valuetext`. It never spins: a ring that stops moving is explained by its words.
 */
export function DownloadRing({
  label,
  progress,
  size = 20,
  status,
  explainRetry = false,
  note,
  className,
}: DownloadRingProps) {
  const { t } = useTranslation();
  const text = useDownloadText(progress);
  const failed = progress.phase === 'failed';
  const done = progress.phase === 'completed';
  // Once every byte has arrived the ring is full; checking and installing are named by the words.
  const arrived = done || progress.phase === 'verifying' || progress.phase === 'installing';
  const fraction = arrived ? 1 : Math.min(1, Math.max(0, (progress.percent ?? 0) / 100));
  const percent = downloadPercentLabel(arrived ? 100 : progress.percent);
  const words =
    status ??
    (progress.phase === 'retrying' && explainRetry
      ? text.status
      : t(`downloadProgress.phase.${progress.phase}`));
  const radius = (size - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={[words, ...(status ? [] : [text.status]), ...text.detail, ...(note ? [note] : [])]
        .filter((part, index, parts) => part && parts.indexOf(part) === index)
        .join(' · ')}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-12',
        failed
          ? 'text-[var(--error-flat)]'
          : done
            ? 'text-[var(--card-status-done)]'
            : 'text-[var(--text-secondary)]',
        className,
      )}
    >
      {done ? (
        <Check size={Math.round(size * 0.7)} className="shrink-0" aria-hidden="true" />
      ) : (
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="shrink-0"
          aria-hidden="true"
          focusable="false"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--msg-tool-card-border)"
            strokeWidth={RING_STROKE}
          />
          {fraction > 0 ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={failed ? 'var(--remote-status-failed)' : 'var(--text-primary)'}
              strokeWidth={RING_STROKE}
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - fraction)}
              strokeLinecap="round"
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              className="transition-[stroke-dashoffset] duration-[var(--motion-fast)] motion-reduce:transition-none"
            />
          ) : null}
        </svg>
      )}
      <span className="min-w-0 truncate" title={note && note !== words ? note : words}>
        {words}
      </span>
    </span>
  );
}
