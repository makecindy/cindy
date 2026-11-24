import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRightLeft,
  HardDrive,
  Info,
  Link2,
  RotateCw,
  ShieldCheck,
} from 'lucide-react';
import { formatBytes } from '@/components/chat/formatBytes';
import {
  extractDriveBadge,
  formatCompactPath,
  WorkspacePathField,
} from './WorkspacePathField';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { SETTINGS_HINT, SettingsBlock, SettingsCard } from '@/components/ui/settings-rows';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { shouldShowOpenPathError } from '../../../shared/openPathResult';
import type {
  WorkspaceMigrationPreview,
  WorkspaceMigrationStatus,
} from '../../../shared/workspaceMigration';
import { useBotTranslation } from './botPronounContext';

function mapMigrationErrorKey(code: string | undefined): string {
  switch (code) {
    case 'INSUFFICIENT_SPACE':
      return 'bots.homeFolder.workspaceLocation.errors.insufficientSpace';
    case 'TARGET_OVERLAPS_CINDY_DATA':
      return 'bots.homeFolder.workspaceLocation.errors.overlapsCindyData';
    case 'LOCAL_DISK_REQUIRED':
    case 'ABSOLUTE_TARGET_REQUIRED':
      return 'bots.homeFolder.workspaceLocation.errors.localDiskRequired';
    case 'UNSUPPORTED_FILE_OR_HARD_LINK':
      return 'bots.homeFolder.workspaceLocation.errors.unsupportedFileOrHardLink';
    case 'WORKSPACE_ALREADY_REDIRECTED':
      return 'bots.homeFolder.workspaceLocation.errors.alreadyRedirected';
    case 'BOT_HOME_IS_REDIRECTED':
      return 'bots.homeFolder.workspaceLocation.errors.botHomeRedirected';
    case 'TARGET_EXISTS':
      return 'bots.homeFolder.workspaceLocation.errors.targetExists';
    case 'WORKSPACE_CHANGED':
    case 'SOURCE_PATH_CHANGED':
      return 'bots.homeFolder.workspaceLocation.errors.workspaceChanged';
    case 'MOVED_BACKUP_RETAINED_FOR_REVIEW':
      return 'bots.homeFolder.workspaceLocation.errors.backupRetained';
    case 'MOVED_BACKUP_CLEANUP_INCOMPLETE':
      return 'bots.homeFolder.workspaceLocation.errors.backupCleanupIncomplete';
    case 'CUTOVER_INTERRUPTED_OR_TARGET_UNAVAILABLE':
      return 'bots.homeFolder.workspaceLocation.errors.cutoverInterrupted';
    default:
      return 'bots.homeFolder.workspaceLocation.errors.generic';
  }
}

function mapStartupWarningKey(code: string | undefined): string | null {
  switch (code) {
    case 'MIGRATION_WAITING_FOR_EXCLUSIVE_STARTUP':
      return 'bots.homeFolder.workspaceLocation.warnings.waitingExclusive';
    case 'MIGRATION_RECEIPT_UPDATE_FAILED':
      return 'bots.homeFolder.workspaceLocation.warnings.receiptUpdateFailed';
    default:
      return null;
  }
}

function badgeMetaForStatus(status: WorkspaceMigrationStatus): {
  key: string;
  dotClass: string;
  textClass: string;
} {
  if (status.phase === 'completed') {
    return status.workspaceAvailable
      ? {
          key: 'bots.homeFolder.workspaceLocation.status.moved',
          dotClass: 'bg-[var(--status-success)]',
          textClass: 'text-[var(--text-primary)]',
        }
      : {
          key: 'bots.homeFolder.workspaceLocation.status.unavailable',
          dotClass: 'bg-[var(--error-fg)]',
          textClass: 'text-[var(--text-danger)]',
        };
  }
  if (status.phase === 'pending') {
    return {
      key: 'bots.homeFolder.workspaceLocation.status.pending',
      dotClass: 'bg-[var(--warning-fg)]',
      textClass: 'text-[var(--text-primary)]',
    };
  }
  if (status.phase === 'failed') {
    return {
      key: 'bots.homeFolder.workspaceLocation.status.failed',
      dotClass: 'bg-[var(--error-fg)]',
      textClass: 'text-[var(--text-danger)]',
    };
  }
  if (['copying', 'prepared', 'switching', 'linked'].includes(status.phase)) {
    return {
      key: 'bots.homeFolder.workspaceLocation.status.interrupted',
      dotClass: 'bg-[var(--error-fg)]',
      textClass: 'text-[var(--text-danger)]',
    };
  }
  return {
    key: 'bots.homeFolder.workspaceLocation.status.default',
    dotClass: 'bg-[var(--text-tertiary)]',
    textClass: 'text-[var(--text-secondary)]',
  };
}

function VolumeChip({ path, emphasized = false }: { path: string; emphasized?: boolean }) {
  const drive = extractDriveBadge(path);
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] px-1.5 font-mono text-11 font-medium',
        emphasized
          ? 'bg-[var(--accent-soft)] text-[var(--accent-emphasis)]'
          : 'bg-[var(--surface-chip)] text-[var(--text-secondary)]',
      )}
      aria-hidden
    >
      <HardDrive size={11} />
      {drive ?? '/'}
    </span>
  );
}

export function BotWorkspaceLocationSettings({ botId }: { botId: string }) {
  const { t } = useBotTranslation();
  const api = window.electronAPI?.localDb?.bots?.workspaceMigration;
  const [status, setStatus] = useState<WorkspaceMigrationStatus | null>(null);
  const [preview, setPreview] = useState<WorkspaceMigrationPreview | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const revision = useRef(0);

  const loadStatus = useCallback(async () => {
    if (!api) return;
    const req = ++revision.current;
    setLoading(true);
    try {
      const next = await api.getStatus(botId);
      if (revision.current === req) {
        setStatus(next);
        setErrorCode(null);
      }
    } catch {
      if (revision.current === req) {
        setStatus(null);
      }
    } finally {
      if (revision.current === req) setLoading(false);
    }
  }, [api, botId]);

  useEffect(() => {
    setPreview(null);
    setErrorCode(null);
    void loadStatus();
    return () => {
      revision.current += 1;
    };
  }, [loadStatus]);

  if (!api) return null;

  const chooseTarget = async () => {
    if (busy) return;
    setBusy(true);
    setErrorCode(null);
    try {
      const result = await api.chooseTarget(botId);
      if (!result.selected) return;
      if ('errorCode' in result) {
        setPreview(null);
        setErrorCode(result.errorCode);
        return;
      }
      setPreview(result.preview);
    } catch {
      setErrorCode('WORKSPACE_MIGRATION_FAILED');
    } finally {
      setBusy(false);
    }
  };

  const scheduleMove = async (restartNow: boolean) => {
    if (busy || !preview) return;
    setBusy(true);
    setErrorCode(null);
    try {
      const result = await api.schedule({
        botId,
        grantId: preview.grantId,
        restartNow,
      });
      setStatus(result.status);
      setPreview(null);
      if (!result.relaunching) {
        toast.success(t('bots.homeFolder.workspaceLocation.scheduledToast'));
      }
    } catch (error) {
      setErrorCode(error instanceof Error ? error.message : 'WORKSPACE_MIGRATION_FAILED');
    } finally {
      setBusy(false);
    }
  };

  const cancelMove = async () => {
    if (busy) return;
    setBusy(true);
    setErrorCode(null);
    try {
      const next = await api.cancel(botId);
      setStatus(next);
      setPreview(null);
      toast.success(t('bots.homeFolder.workspaceLocation.cancelledToast'));
    } catch {
      setErrorCode('MIGRATION_CANNOT_CANCEL');
    } finally {
      setBusy(false);
    }
  };

  const restartNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.restart(botId);
    } catch {
      setBusy(false);
      toast.error(t('bots.homeFolder.workspaceLocation.errors.generic'));
    }
  };

  const openFolder = async (folderPath: string) => {
    try {
      const result = await window.electronAPI.openPath(folderPath);
      if (shouldShowOpenPathError(result)) {
        toast.error(result.error ?? t('bots.homeFolder.openFailed'));
      }
    } catch {
      toast.error(t('bots.homeFolder.openFailed'));
    }
  };

  const copyPath = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('bots.homeFolder.workspaceLocation.pathCopied'));
    } catch {
      toast.error(t('bots.homeFolder.workspaceLocation.pathCopyFailed'));
    }
  };

  if (loading && !status) {
    return (
      <div role="status" className="py-1">
        <Spinner size={16} />
      </div>
    );
  }

  if (!status) return null;

  const isMoved = status.phase === 'completed';
  const isPending = status.phase === 'pending';
  const isFailed = status.phase === 'failed';
  const isInterrupted = ['copying', 'prepared', 'switching', 'linked'].includes(status.phase);
  const canStartMove =
    status.canSchedule && (status.phase === 'none' || status.phase === 'cancelled' || isFailed);
  const displayedPath = isMoved && status.target ? status.target : status.source;
  const warningKey = mapStartupWarningKey(status.startupWarning);
  const badge = badgeMetaForStatus(status);
  const canOpenDisplayed = !(isMoved && !status.workspaceAvailable);

  return (
    <SettingsCard>
      {/* Primary form header + tactile path well */}
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                role="heading"
                aria-level={3}
                className="text-13 font-medium leading-[1.4] text-[var(--settings-section-title)]"
              >
                {t('bots.homeFolder.workspaceLocation.title')}
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 font-medium',
                  badge.textClass,
                )}
              >
                <span className={cn('size-1.5 shrink-0 rounded-full', badge.dotClass)} aria-hidden />
                {t(badge.key)}
              </span>
            </div>
            <p className="mt-1 text-12 leading-[1.45] text-[var(--text-secondary)] [text-wrap:pretty]">
              {t(
                isMoved
                  ? 'bots.homeFolder.workspaceLocation.movedDescription'
                  : 'bots.homeFolder.workspaceLocation.description',
              )}
            </p>
          </div>

          {canStartMove ? (
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                compact
                className="gap-1.5"
                disabled={busy}
                onClick={() => void chooseTarget()}
              >
                {busy ? <Spinner size={13} /> : <ArrowRightLeft size={13} aria-hidden />}
                {t(
                  isFailed
                    ? 'bots.homeFolder.workspaceLocation.chooseAnother'
                    : 'bots.homeFolder.workspaceLocation.moveAction',
                )}
              </Button>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <WorkspacePathField
            path={displayedPath}
            linkedPath={isMoved ? status.source : undefined}
            linkedPathLabel={t('bots.homeFolder.workspaceLocation.logicalPathLabel')}
            fullPathLabel={t('bots.homeFolder.workspaceLocation.fullPath')}
            primaryPathLabel={
              isMoved
                ? t('bots.homeFolder.workspaceLocation.targetPathLabel')
                : t('bots.homeFolder.workspaceLocation.fullPath')
            }
            copyLabel={t('bots.homeFolder.workspaceLocation.copyPath')}
            openLabel={
              canOpenDisplayed ? t('bots.homeFolder.workspaceLocation.openTarget') : undefined
            }
            onCopy={copyPath}
            onOpen={canOpenDisplayed ? () => openFolder(displayedPath) : undefined}
            disabled={busy}
          />

          {isMoved ? (
            <div className="flex min-w-0 items-center gap-1.5 pl-0.5 text-11 text-[var(--text-tertiary)]">
              <Link2 size={12} className="shrink-0" aria-hidden />
              <span className="shrink-0">
                {t('bots.homeFolder.workspaceLocation.logicalPathLabel')}
              </span>
              <span aria-hidden>·</span>
              <span
                className="min-w-0 truncate font-mono text-[var(--text-secondary)]"
                title={status.source}
              >
                {formatCompactPath(status.source)}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {/* Inline migration plan — clean hairline band with From → To route & CTA hierarchy */}
      {preview ? (
        <div
          data-testid="workspace-migration-preview"
          className="flex flex-col gap-3.5 border-t border-[var(--border-default)] bg-[var(--surface-on-card)] px-5 py-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-13 font-medium text-[var(--text-primary)]">
              {t('bots.homeFolder.workspaceLocation.previewTitle')}
            </p>
            <span className="rounded-full bg-[var(--surface-chip)] px-2.5 py-0.5 text-11 font-medium tabular-nums text-[var(--text-secondary)]">
              {t('bots.homeFolder.workspaceLocation.previewSummary', {
                size: formatBytes(Number(preview.bytes)),
                files: preview.files,
                links: preview.links,
              })}
            </span>
          </div>

          <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3">
            <div className="flex min-w-0 items-center gap-2">
              <VolumeChip path={preview.source} />
              <span
                className="min-w-0 flex-1 truncate font-mono text-12 text-[var(--text-secondary)]"
                title={preview.source}
              >
                {formatCompactPath(preview.source)}
              </span>
            </div>
            <div className="flex items-center gap-2 pl-2">
              <ArrowDown size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
              <div className="h-px flex-1 bg-[var(--border-default)]/70" aria-hidden />
            </div>
            <div className="flex min-w-0 items-start gap-2">
              <VolumeChip path={preview.target} emphasized />
              <span className="min-w-0 flex-1 select-text break-all font-mono text-12 font-medium leading-[1.45] text-[var(--text-primary)]">
                {preview.target}
              </span>
            </div>
          </div>

          <p className="flex items-start gap-2 text-12 leading-[1.45] text-[var(--text-secondary)] [text-wrap:pretty]">
            <ShieldCheck
              size={14}
              className="mt-0.5 shrink-0 text-[var(--status-success)]"
              aria-hidden
            />
            {t('bots.homeFolder.workspaceLocation.previewNotice')}
          </p>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            <Button
              type="button"
              variant="secondary"
              tone="quiet"
              size="sm"
              compact
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              {t('bots.homeFolder.workspaceLocation.cancel')}
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                compact
                disabled={busy}
                onClick={() => void scheduleMove(false)}
              >
                {t('bots.homeFolder.workspaceLocation.scheduleNextRestart')}
              </Button>
              <Button
                type="button"
                variant="cta"
                size="sm"
                compact
                className="gap-1.5"
                disabled={busy}
                onClick={() => void scheduleMove(true)}
              >
                {busy ? <Spinner size={13} /> : <RotateCw size={13} aria-hidden />}
                {t('bots.homeFolder.workspaceLocation.restartAndMove')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Pending restart banner — calm tinted footer band */}
      {isPending && status.target ? (
        <div
          data-testid="workspace-migration-pending"
          className="flex flex-col gap-3 border-t border-[var(--border-default)] bg-[var(--warning-bg-soft)]/45 px-5 py-4"
        >
          <div className="flex flex-col gap-1.5">
            <div className="flex min-w-0 items-start gap-2">
              <VolumeChip path={status.target} emphasized />
              <p className="min-w-0 flex-1 select-text break-all font-mono text-12 font-medium leading-[1.45] text-[var(--text-primary)]">
                {t('bots.homeFolder.workspaceLocation.pendingTarget', { target: status.target })}
              </p>
            </div>
            <p className={SETTINGS_HINT}>
              {t('bots.homeFolder.workspaceLocation.pendingHint')}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              tone="quiet"
              size="sm"
              compact
              disabled={busy}
              onClick={() => void cancelMove()}
            >
              {t('bots.homeFolder.workspaceLocation.cancel')}
            </Button>
            <Button
              type="button"
              variant="cta"
              size="sm"
              compact
              className="gap-1.5"
              disabled={busy || !status.canSchedule}
              onClick={() => void restartNow()}
            >
              {busy ? <Spinner size={13} /> : <RotateCw size={13} aria-hidden />}
              {t('bots.homeFolder.workspaceLocation.restartNow')}
            </Button>
          </div>
        </div>
      ) : null}

      {isMoved && !status.workspaceAvailable ? (
        <SettingsBlock>
          <ErrorNotice
            role="alert"
            message={t('bots.homeFolder.workspaceLocation.unavailableTitle')}
            description={t('bots.homeFolder.workspaceLocation.unavailableDescription', {
              target: status.target ?? '',
            })}
          />
        </SettingsBlock>
      ) : null}

      {errorCode ? (
        <SettingsBlock>
          <ErrorNotice
            role="alert"
            message={t('bots.homeFolder.workspaceLocation.errorTitle')}
            description={t(mapMigrationErrorKey(errorCode))}
          />
        </SettingsBlock>
      ) : null}

      {isFailed || isInterrupted ? (
        <SettingsBlock>
          <ErrorNotice
            role="alert"
            message={t(
              isInterrupted
                ? 'bots.homeFolder.workspaceLocation.interruptedTitle'
                : 'bots.homeFolder.workspaceLocation.failedTitle',
            )}
            description={t(mapMigrationErrorKey(status.error))}
            actions={
              isFailed ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  compact
                  disabled={busy}
                  onClick={() => void cancelMove()}
                >
                  {t('bots.homeFolder.workspaceLocation.dismissFailed')}
                </Button>
              ) : undefined
            }
          />
        </SettingsBlock>
      ) : null}

      {warningKey ? (
        <SettingsBlock>
          <p className={cn('flex items-start gap-1.5', SETTINGS_HINT)} role="status">
            <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
            {t(warningKey)}
          </p>
        </SettingsBlock>
      ) : null}

      {isMoved && status.backupRemaining && status.backup ? (
        <SettingsBlock>
          <p className={cn('flex items-start gap-1.5', SETTINGS_HINT)} role="status">
            <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
            {t('bots.homeFolder.workspaceLocation.backupRemainingHint', {
              backup: status.backup,
            })}
          </p>
        </SettingsBlock>
      ) : null}

      {!status.canSchedule && !isMoved ? (
        <SettingsBlock>
          <p className={cn('flex items-start gap-1.5', SETTINGS_HINT)}>
            <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
            {t('bots.homeFolder.workspaceLocation.personalPreviewHint')}
          </p>
        </SettingsBlock>
      ) : null}
    </SettingsCard>
  );
}
