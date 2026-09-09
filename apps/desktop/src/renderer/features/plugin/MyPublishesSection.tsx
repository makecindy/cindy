import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { extractIpcError } from '@/utils/ipcError';
import { cn } from '@/lib/utils';

interface ReleaseRow {
  uploadId: string;
  status: string;
  reviewStatus: string | null;
  ghostId: string | null;
  version: string | null;
  createdAt?: string;
  updatedAt?: string;
  failure?: { code: string; message: string } | null;
}

interface TransferProgress {
  transferId: string;
  uploadId: string | null;
  stage: string;
  bytesHashed?: number;
  bytesSent?: number;
  totalBytes?: number;
  status?: string;
  reviewStatus?: string | null;
  ghostId?: string | null;
  version?: string | null;
  pluginName?: string | null;
  message?: string | null;
}

function isProgress(value: unknown): value is TransferProgress {
  return Boolean(value && typeof value === 'object' && typeof (value as { transferId?: unknown }).transferId === 'string');
}

function badgeKey(status: string, reviewStatus: string | null): string {
  if (status === 'validating' || status === 'publishing') return 'validating';
  if (status === 'succeeded' && reviewStatus === 'pending') return 'pending';
  if (status === 'succeeded' && reviewStatus === 'approved') return 'approved';
  if (status === 'succeeded' && reviewStatus === 'rejected') return 'rejected';
  if (status === 'failed') return 'failed';
  if (status === 'expired') return 'expired';
  return 'processing';
}

export function MyPublishesSection({
  enabled,
  onPublish,
}: {
  enabled: boolean;
  onPublish: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [releases, setReleases] = useState<ReleaseRow[]>([]);
  const [disabledReason, setDisabledReason] = useState<string | null>(null);
  const [active, setActive] = useState<TransferProgress | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const page = await window.electronAPI.pluginPublisher.listMine();
      setDisabledReason(null);
      setReleases(
        page.releases.map((raw) => ({
          uploadId: String(raw.uploadId ?? ''),
          status: String(raw.status ?? ''),
          reviewStatus: typeof raw.reviewStatus === 'string' ? raw.reviewStatus : null,
          ghostId: typeof raw.ghostId === 'string' ? raw.ghostId : null,
          version: typeof raw.version === 'string' ? raw.version : null,
          createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
          failure:
            raw.failure && typeof raw.failure === 'object'
              ? {
                  code: String((raw.failure as { code?: unknown }).code ?? ''),
                  message: String((raw.failure as { message?: unknown }).message ?? ''),
                }
              : null,
        })),
      );
    } catch (error) {
      const decoded = extractIpcError(error);
      if (decoded?.code === 'PERMISSION_DENIED') {
        setDisabledReason(t('settings.ghosts.publish.disabled'));
        setReleases([]);
        return;
      }
      setDisabledReason(t('settings.ghosts.publish.loadFailed'));
    }
  }, [enabled, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  useEffect(() => {
    return window.electronAPI.pluginPublisher.onProgress((raw) => {
      if (!isProgress(raw)) return;
      setActive(raw.stage === 'succeeded' || raw.stage === 'failed' || raw.stage === 'expired' || raw.stage === 'cancelled' ? null : raw);
      if (raw.stage === 'succeeded' || raw.stage === 'failed' || raw.stage === 'expired') {
        void refresh();
      }
    });
  }, [refresh]);

  if (!enabled) return null;

  const percent =
    active?.totalBytes && active.totalBytes > 0
      ? Math.min(100, Math.round(((active.bytesSent ?? active.bytesHashed ?? 0) / active.totalBytes) * 100))
      : null;

  return (
    <section className="plugin-motion-page-section mt-10 min-w-0">
      <div className="mb-4 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 items-baseline gap-2 text-left"
        >
          <h2 className="text-20 font-medium text-[var(--text-primary)]">
            {t('settings.ghosts.publish.section')}
          </h2>
          <span className="text-13 tabular-nums text-[var(--text-tertiary)]">{releases.length}</span>
        </button>
        <button
          type="button"
          onClick={onPublish}
          className="inline-flex h-9 shrink-0 items-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 text-12 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          {t('settings.ghosts.publish.action')}
        </button>
      </div>
      {expanded ? (
        <div className="space-y-2">
          {disabledReason ? (
            <p className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-3 text-12 text-[var(--text-secondary)]">
              {disabledReason}
            </p>
          ) : null}
          {active ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-13 font-medium text-[var(--text-primary)]">
                  {active.pluginName ?? active.ghostId ?? t('settings.ghosts.publish.uploading')}
                </p>
                <p className="text-12 text-[var(--text-secondary)]">
                  {t(`settings.ghosts.publish.stage.${active.stage}`)}
                  {percent !== null ? ` · ${percent}%` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void window.electronAPI.pluginPublisher.cancel(active.transferId)}
                className="shrink-0 rounded-full px-3 py-1 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)]"
              >
                {t('settings.ghosts.publish.cancel')}
              </button>
            </div>
          ) : null}
          {releases.map((release) => {
            const key = badgeKey(release.status, release.reviewStatus);
            return (
              <div
                key={release.uploadId}
                className="flex items-center justify-between gap-3 rounded-xl border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-13 font-medium text-[var(--text-primary)]">
                    {release.ghostId ?? t('settings.ghosts.publish.unknownPlugin')}
                    {release.version ? ` · ${release.version}` : ''}
                  </p>
                  {release.failure?.message ? (
                    <p className="truncate text-12 text-[var(--text-secondary)]">{release.failure.message}</p>
                  ) : (
                    <p className="text-12 text-[var(--text-tertiary)]">
                      {release.updatedAt ?? release.createdAt ?? ''}
                    </p>
                  )}
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2.5 py-1 text-11',
                    key === 'approved'
                      ? 'bg-[var(--success-soft)] text-[var(--success)]'
                      : key === 'failed' || key === 'rejected' || key === 'expired'
                        ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                        : 'bg-[var(--surface-chip)] text-[var(--text-secondary)]',
                  )}
                >
                  {t(`settings.ghosts.publish.badge.${key}`)}
                </span>
              </div>
            );
          })}
          {!disabledReason && releases.length === 0 && !active ? (
            <p className="rounded-xl border-[0.5px] border-[var(--border-default)] px-5 py-8 text-center text-13 text-[var(--text-secondary)]">
              {t('settings.ghosts.publish.empty')}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
