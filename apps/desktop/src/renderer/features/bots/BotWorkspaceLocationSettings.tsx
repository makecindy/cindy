import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRightLeft,
  Clock,
  Folder,
  FolderCheck,
  FolderX,
  Info,
  RotateCw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { formatBytes } from '@/components/chat/formatBytes';
import { WorkspacePathField } from './WorkspacePathField';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { SETTINGS_HINT, SettingsBlock, SettingsCard } from '@/components/ui/settings-rows';
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
    case 'MOVED_WORKSPACE_UNAVAILABLE':
      return 'bots.homeFolder.workspaceLocation.unavailableTitle';
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
  Icon: LucideIcon;
  textClass: string;
} {
  if (status.phase === 'completed' && (status.currentTarget || !status.workspaceAvailable)) {
    return status.workspaceAvailable
      ? {
          key: 'bots.homeFolder.workspaceLocation.status.moved',
          Icon: FolderCheck,
          textClass: 'text-[var(--text-primary)]',
        }
      : {
          key: 'bots.homeFolder.workspaceLocation.status.unavailable',
          Icon: FolderX,
          textClass: 'text-[var(--text-danger)]',
        };
  }
  if (status.phase === 'pending') {
    return {
      key: 'bots.homeFolder.workspaceLocation.status.pending',
      Icon: Clock,
      textClass: 'text-[var(--text-primary)]',
    };
  }
  if (status.phase === 'failed') {
    return {
      key: 'bots.homeFolder.workspaceLocation.status.failed',
      Icon: TriangleAlert,
      textClass: 'text-[var(--text-danger)]',
    };
  }
  if (['copying', 'prepared', 'switching', 'linked'].includes(status.phase)) {
    return {
      key: 'bots.homeFolder.workspaceLocation.status.interrupted',
      Icon: TriangleAlert,
      textClass: 'text-[var(--text-danger)]',
    };
  }
  return {
    key: 'bots.homeFolder.workspaceLocation.status.default',
    Icon: Folder,
    textClass: 'text-[var(--text-secondary)]',
  };
}

type MoveAction = 'choose' | 'choose-default' | 'schedule' | 'schedule-restart' | 'cancel' | 'restart';

export function BotWorkspaceLocationSettings({ botId }: { botId: string }) {
  const { t } = useBotTranslation();
  const api = window.electronAPI?.localDb?.bots?.workspaceMigration;
  const [status, setStatus] = useState<WorkspaceMigrationStatus | null>(null);
  const [preview, setPreview] = useState<WorkspaceMigrationPreview | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [action, setAction] = useState<MoveAction | null>(null);
  const busy = Boolean(action);
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

  const chooseTarget = async (useDefault = false) => {
    if (busy) return;
    setAction(useDefault ? 'choose-default' : 'choose');
    setErrorCode(null);
    try {
      const result = await api.chooseTarget(botId, useDefault);
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
      setAction(null);
    }
  };

  const scheduleMove = async (restartNow: boolean) => {
    if (busy || !preview) return;
    setAction(restartNow ? 'schedule-restart' : 'schedule');
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
      setAction(null);
    }
  };

  const cancelMove = async () => {
    if (busy) return;
    setAction('cancel');
    setErrorCode(null);
    try {
      const next = await api.cancel(botId);
      setStatus(next);
      setPreview(null);
      toast.success(t('bots.homeFolder.workspaceLocation.cancelledToast'));
    } catch {
      setErrorCode('MIGRATION_CANNOT_CANCEL');
    } finally {
      setAction(null);
    }
  };

  const restartNow = async () => {
    if (busy) return;
    setAction('restart');
    try {
      const { relaunching } = await api.restart(botId);
      if (!relaunching) {
        setAction(null);
        void loadStatus();
      }
    } catch {
      setAction(null);
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
      <SettingsCard
        role="status"
        aria-label={t('bots.homeFolder.workspaceLocation.title')}
        aria-busy
        className="flex flex-col gap-3 px-5 py-4"
      >
        <div aria-hidden="true" className="h-3 w-28 rounded-full bg-[var(--surface-chip)]" />
        <div aria-hidden="true" className="h-9 rounded-lg bg-[var(--surface-chip)]" />
        <div aria-hidden="true" className="h-7 w-28 self-end rounded-full bg-[var(--surface-chip)]" />
      </SettingsCard>
    );
  }

  if (!status) return null;

  const isMoved = Boolean(status.currentTarget);
  const isPending = status.phase === 'pending';
  const isFailed = status.phase === 'failed';
  const isInterrupted = ['copying', 'prepared', 'switching', 'linked'].includes(status.phase);
  const canStartMove =
    status.canSchedule && status.workspaceAvailable && !isPending && !isInterrupted;
  const displayedPath = status.currentTarget ?? status.source;
  const warningKey = mapStartupWarningKey(status.startupWarning);
  const badge = badgeMetaForStatus(status);
  const canOpenDisplayed = status.workspaceAvailable;
  const currentPathLabel = t('bots.homeFolder.workspaceLocation.currentPathLabel');
  const targetPathLabel = t('bots.homeFolder.workspaceLocation.targetPathLabel');
  const defaultPathLabel = t('bots.homeFolder.workspaceLocation.defaultPathLabel');
  const previewTargetLabel = preview?.target === status.source ? defaultPathLabel : targetPathLabel;
  const pathFieldProps = {
    fullPathLabel: t('bots.homeFolder.workspaceLocation.fullPath'),
    copyLabel: t('bots.homeFolder.workspaceLocation.copyPath'),
    onCopy: copyPath,
    disabled: busy,
  };

  return (
    <SettingsCard>
      {!preview ? (
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span
                role="heading"
                aria-level={3}
                className="min-w-0 truncate text-13 font-medium leading-[1.4] text-[var(--settings-section-title)]"
              >
                {t('bots.homeFolder.workspaceLocation.title')}
              </span>
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 font-medium',
                  badge.textClass,
                )}
              >
                <badge.Icon size={12} className="shrink-0" aria-hidden />
                {t(badge.key)}
              </span>
            </div>
            <p className="text-12 leading-[1.5] text-[var(--text-secondary)] [text-wrap:pretty]">
              {t(
                isMoved
                  ? 'bots.homeFolder.workspaceLocation.movedDescription'
                  : 'bots.homeFolder.workspaceLocation.description',
              )}
            </p>
          </div>

          <WorkspacePathField
            {...pathFieldProps}
            path={displayedPath}
            linkedPath={isMoved ? status.source : undefined}
            linkedPathLabel={t('bots.homeFolder.workspaceLocation.logicalPathLabel')}
            primaryPathLabel={currentPathLabel}
            openLabel={
              canOpenDisplayed ? t('bots.homeFolder.workspaceLocation.openTarget') : undefined
            }
            onOpen={canOpenDisplayed ? () => openFolder(displayedPath) : undefined}
          />

          {canStartMove ? (
            <div className="flex flex-wrap items-center justify-end gap-2 pt-0.5">
              {isMoved ? (
                <Button
                  type="button"
                  variant="secondary"
                  tone="quiet"
                  size="sm"
                  compact
                  disabled={busy}
                  loading={action === 'choose-default'}
                  onClick={() => void chooseTarget(true)}
                >
                  {t('bots.homeFolder.workspaceLocation.moveBackAction')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                compact
                className="gap-1.5"
                disabled={busy}
                loading={action === 'choose'}
                onClick={() => void chooseTarget()}
              >
                <ArrowRightLeft size={13} aria-hidden />
                {t(
                  isFailed
                    ? 'bots.homeFolder.workspaceLocation.chooseAnother'
                    : 'bots.homeFolder.workspaceLocation.moveAction',
                )}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div
          data-testid="workspace-migration-preview"
          className="flex min-w-0 flex-col gap-3 px-5 py-4"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-13 font-medium text-[var(--settings-section-title)]">
                {t('bots.homeFolder.workspaceLocation.previewTitle')}
              </h3>
              <p className="mt-1 text-11 tabular-nums text-[var(--text-secondary)]">
                {t('bots.homeFolder.workspaceLocation.previewSummary', {
                  size: formatBytes(Number(preview.bytes)),
                })}
              </p>
            </div>
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
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <div role="group" aria-label={currentPathLabel} className="flex min-w-0 flex-col gap-1">
              <p className={SETTINGS_HINT}>{currentPathLabel}</p>
              <WorkspacePathField
                {...pathFieldProps}
                hideInlineCopy
                path={preview.source}
                primaryPathLabel={currentPathLabel}
              />
            </div>
            <ArrowDown size={14} className="ml-3 text-[var(--text-secondary)]" aria-hidden />
            <div role="group" aria-label={previewTargetLabel} className="flex min-w-0 flex-col gap-1">
              <p className="text-12 font-medium text-[var(--text-primary)]">
                {previewTargetLabel}
              </p>
              <WorkspacePathField
                {...pathFieldProps}
                hideInlineCopy
                path={preview.target}
                primaryPathLabel={previewTargetLabel}
              />
            </div>
          </div>

          <p className={SETTINGS_HINT}>
            {t('bots.homeFolder.workspaceLocation.previewNotice')}
          </p>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-0.5">
            <Button
              type="button"
              variant="secondary"
              tone="quiet"
              size="sm"
              compact
              disabled={busy}
              loading={action === 'schedule'}
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
              loading={action === 'schedule-restart'}
              onClick={() => void scheduleMove(true)}
            >
              <RotateCw size={13} aria-hidden />
              {t('bots.homeFolder.workspaceLocation.restartAndMove')}
            </Button>
          </div>
        </div>
      )}

      {/* Pending restart banner — calm tinted footer band */}
      {isPending && status.target ? (
        <div
          data-testid="workspace-migration-pending"
          className="flex flex-col gap-3 border-t border-[var(--border-default)] bg-[var(--warning-bg-soft)]/45 px-5 py-4"
        >
          <div className="flex flex-col gap-1.5">
            <p className={SETTINGS_HINT}>
              {status.target === status.source ? defaultPathLabel : targetPathLabel}
            </p>
            <WorkspacePathField
              {...pathFieldProps}
              hideInlineCopy
              path={status.target}
              primaryPathLabel={targetPathLabel}
            />
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
              loading={action === 'cancel'}
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
              loading={action === 'restart'}
              onClick={() => void restartNow()}
            >
              <RotateCw size={13} aria-hidden />
              {t('bots.homeFolder.workspaceLocation.restartNow')}
            </Button>
          </div>
        </div>
      ) : null}

      {(isMoved || status.phase === 'completed') && !status.workspaceAvailable ? (
        <SettingsBlock>
          <ErrorNotice
            role="alert"
            message={t('bots.homeFolder.workspaceLocation.unavailableTitle')}
            description={t('bots.homeFolder.workspaceLocation.unavailableDescription', {
              target: displayedPath,
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
                  loading={action === 'cancel'}
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

      {status.phase === 'completed' && status.backupRemaining && status.backup ? (
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
