import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ChevronDown,
  GitBranch,
  History,
  Minus,
  Plus,
  Sparkles,
  Undo2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type {
  ReviewData,
  ReviewFileTarget,
  ReviewHistoryData,
  ReviewStageOperationResult,
} from '@/lib/gitReview.types';
import { gitReviewApiFor } from '@/lib/gitReviewTransport';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { relativeTime } from '@/components/settings/deviceLabels';
import { buildDeterministicCommitMessage } from '../../../../shared/gitCommitMessage';
import { openCommitReview } from '../../right-sidebar/lib/openCommitReview';
import { filterFiles } from './lib/filterFiles';
import { pickFileIcon } from './lib/fileIcon';
import {
  WORKDIR_GIT_STATUS_VISUAL,
  type WorkdirGitFileChange,
} from './lib/workdirGitStatus';

const AUTO_PUSH_STORAGE_KEY = 'cc-agent.fileBrowser.autoPush';

export function ChangedFilesList({
  sessionId,
  deviceId,
  data,
  changes,
  query,
  selectedPath,
  loading,
  error,
  onSelectFile,
  onGitStateChanged,
  onRefresh,
}: {
  sessionId: string | null | undefined;
  deviceId: string | null;
  data: ReviewData | null;
  changes: ReadonlyMap<string, WorkdirGitFileChange>;
  query: string;
  selectedPath: string | null;
  loading: boolean;
  error: string | null;
  onSelectFile: (relPath: string) => void;
  onGitStateChanged: () => void;
  /** 面板打开时重新读一次状态：应用内保存文件后列表不该还是旧的。 */
  onRefresh?: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [autoPush, setAutoPush] = useState(() => {
    try {
      return window.localStorage.getItem(AUTO_PUSH_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [operationError, setOperationError] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [history, setHistory] = useState<ReviewHistoryData | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [generatingMessage, setGeneratingMessage] = useState(false);
  const paths = useMemo(() => [...changes.keys()].sort(), [changes]);
  const stagedPaths = useMemo(
    () => paths.filter((path) => changes.get(path)?.staged),
    [paths, changes],
  );
  const unstagedPaths = useMemo(
    () => paths.filter((path) => changes.get(path)?.unstaged),
    [paths, changes],
  );
  const visibleStagedPaths = useMemo(
    () => (query.trim() ? filterFiles(query, stagedPaths, 1_000) : stagedPaths),
    [query, stagedPaths],
  );
  const visibleUnstagedPaths = useMemo(
    () => (query.trim() ? filterFiles(query, unstagedPaths, 1_000) : unstagedPaths),
    [query, unstagedPaths],
  );
  const visiblePaths = useMemo(
    () => (query.trim() ? filterFiles(query, paths, 1_000) : paths),
    [paths, query],
  );
  const deterministicMessage = useMemo(
    () =>
      buildDeterministicCommitMessage(
        data && stagedPaths.length > 0
          ? {
              ...data,
              status: data.status
                ? {
                    ...data.status,
                    files: data.status.files.filter((file) =>
                      file.sources.includes('staged'),
                    ),
                  }
                : null,
            }
          : data,
      ),
    [data, stagedPaths.length],
  );
  const [commitMessage, setCommitMessage] = useState(deterministicMessage);
  const commitMessageDirtyRef = useRef(false);
  useEffect(() => {
    if (!commitMessageDirtyRef.current) setCommitMessage(deterministicMessage);
  }, [deterministicMessage]);
  const canWrite = Boolean(
    sessionId &&
      !deviceId &&
      data &&
      data.status?.writeDisabledReasons.length === 0,
  );
  const ahead = data?.scope.aheadBehind.ahead ?? 0;
  const behind = data?.scope.aheadBehind.behind ?? 0;
  const upstream = data?.scope.aheadBehind.upstream ?? null;
  const diverged = ahead > 0 && behind > 0;
  const commitBlocked = behind > 0 && ahead === 0;
  const includeUnstaged = stagedPaths.length === 0;
  const pushBranch = data?.scope.isDetached
    ? data.scope.headOid
      ? t('rightSidebar.review.detachedHead', { oid: data.scope.headOid.slice(0, 7) })
      : t('rightSidebar.review.branchUnknown')
    : data?.scope.branch || t('rightSidebar.review.branchUnknown');
  const branchWebUrl = data?.scope.branchWebUrl ?? null;

  const loadHistory = useCallback(async () => {
    if (!sessionId) return;
    setHistoryLoading(true);
    try {
      setHistory(await gitReviewApiFor(deviceId).history({ sessionId, limit: 20 }));
    } catch {
      setHistory(null);
    } finally {
      setHistoryLoading(false);
    }
  }, [sessionId, deviceId]);

  useEffect(() => {
    void loadHistory();
    const onFocus = () => void loadHistory();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadHistory]);

  const applyStage = async (
    action: 'stage' | 'unstage',
    targets: ReviewFileTarget[],
    key: string,
  ) => {
    if (!sessionId || targets.length === 0 || !canWrite) return;
    setPendingKey(key);
    try {
      const single = targets.length === 1;
      const result =
        action === 'stage'
          ? single
            ? await window.electronAPI.gitReview.stageFile({ sessionId, targets })
            : await window.electronAPI.gitReview.stageAll({ sessionId, targets })
          : single
            ? await window.electronAPI.gitReview.unstageFile({ sessionId, targets })
            : await window.electronAPI.gitReview.unstageAll({ sessionId, targets });
      if (result.operation.failed.length > 0) {
        toast.error(
          t('rightSidebar.review.actions.partialFailure', {
            succeeded: result.operation.succeeded.length,
            failed: result.operation.failed.length,
          }),
        );
      }
      onGitStateChanged();
    } catch (err) {
      toast.error(extractIpcError(err)?.message ?? String(err));
    } finally {
      setPendingKey(null);
    }
  };

  const pullUpdates = async () => {
    if (!sessionId || !canWrite || pulling) return;
    setPulling(true);
    setOperationError(null);
    try {
      await window.electronAPI.gitReview.pull({ sessionId });
      toast.success(t('rightSidebar.fileBrowser.pullSuccess'));
      onGitStateChanged();
      void loadHistory();
    } catch (err) {
      setOperationError({
        title: t('rightSidebar.fileBrowser.pullFailedTitle'),
        message: extractIpcError(err)?.message ?? String(err),
      });
    } finally {
      setPulling(false);
    }
  };

  const revert = async (targets: ReviewFileTarget[], key: string, scope: 'file' | 'section') => {
    if (!sessionId || targets.length === 0 || !canWrite) return;
    const count = scope === 'file' ? 1 : changes.size;
    const untrackedCount = targets.filter(
      (target) => changes.get(target.path)?.kind === 'untracked',
    ).length;
    const confirmed = await confirm({
      title: t(`rightSidebar.review.discard.confirm.${scope}.title`, {
        count,
      }),
      description:
        untrackedCount > 0
          ? t(`rightSidebar.review.discard.confirm.${scope}.descWithUntracked`, {
              count,
              untrackedCount,
            })
          : t(`rightSidebar.review.discard.confirm.${scope}.desc`, {
              count,
            }),
      confirmText: t('rightSidebar.review.discard.confirm.confirm'),
      cancelText: t('rightSidebar.review.discard.confirm.cancel'),
    });
    if (!confirmed) return;

    setPendingKey(key);
    try {
      const result = await discardFileChanges(sessionId, targets);
      if (result.operation.failed.length > 0) {
        toast.error(
          t('rightSidebar.review.actions.partialFailure', {
            succeeded: result.operation.succeeded.length,
            failed: result.operation.failed.length,
          }),
        );
      }
      onGitStateChanged();
    } catch (err) {
      const message = extractIpcError(err)?.message ?? String(err);
      toast.error(message);
    } finally {
      setPendingKey(null);
    }
  };

  const generateAiMessage = async () => {
    if (!sessionId || !canWrite || generatingMessage) return;
    setGeneratingMessage(true);
    try {
      const draft = await window.electronAPI.gitReview.commitMessage({
        sessionId,
        includeUnstaged,
      });
      commitMessageDirtyRef.current = true;
      setCommitMessage(draft.message);
      if (draft.source === 'fallback') {
        toast.warning(t('rightSidebar.fileBrowser.aiCommitFallback'));
      }
    } catch (err) {
      toast.error(extractIpcError(err)?.message ?? String(err));
    } finally {
      setGeneratingMessage(false);
    }
  };

  const commitChanges = async () => {
    const message = commitMessage.trim();
    if (!sessionId || !canWrite || changes.size === 0 || committing || !message) return;
    if (commitBlocked) return;
    setCommitting(true);
    setOperationError(null);
    let committed = false;
    try {
      const result = await window.electronAPI.gitReview.commit({
        sessionId,
        message,
        includeUnstaged,
      });
      committed = true;
      commitMessageDirtyRef.current = false;
      onGitStateChanged();
      void loadHistory();
      toast.success(
        t('rightSidebar.fileBrowser.commitSuccess', { oid: result.commitOid.slice(0, 8) }),
      );
      if (!autoPush) return;
      if (result.data.scope.aheadBehind.behind > 0) {
        setOperationError({
          title: t('rightSidebar.review.push.failedTitle'),
          message: t('rightSidebar.fileBrowser.pullBeforePush'),
        });
        return;
      }

      let pushResult = await window.electronAPI.gitReview.push({ sessionId });
      if (pushResult.kind === 'needs-force') {
        const confirmed = await confirm({
          title: t('rightSidebar.review.push.forceTitle'),
          description: t('rightSidebar.review.push.forceDesc', {
            count: pushResult.behind,
            remoteRef: pushResult.remoteRef,
          }),
          confirmText: t('rightSidebar.review.push.forceConfirm'),
          cancelText: t('rightSidebar.review.push.forceCancel'),
        });
        if (!confirmed) return;
        pushResult = await window.electronAPI.gitReview.push({
          sessionId,
          confirmForce: {
            remoteRef: pushResult.remoteRef,
            expectedOid: pushResult.remoteOid,
          },
        });
        if (pushResult.kind === 'needs-force') {
          throw new Error(t('rightSidebar.review.push.forceStillRejected'));
        }
      }
      toast.success(t('rightSidebar.review.push.successToast'));
      onGitStateChanged();
      void loadHistory();
    } catch (err) {
      const message = extractIpcError(err)?.message ?? String(err);
      if (committed) {
        setOperationError({
          title: t('rightSidebar.review.push.failedTitle'),
          message,
        });
      }
      else toast.error(message);
    } finally {
      setCommitting(false);
    }
  };

  const renderRow = (path: string, source: 'staged' | 'unstaged') => {
    const change = changes.get(path);
    if (!change) return null;
    const slash = path.lastIndexOf('/');
    const name = slash < 0 ? path : path.slice(slash + 1);
    const directory = slash < 0 ? '' : path.slice(0, slash);
    const Icon = pickFileIcon(name);
    const visual = WORKDIR_GIT_STATUS_VISUAL[change.kind];
    const statusColor = selectedPath === path ? undefined : visual.color;
    const rowKey = `${source}:${path}`;
    const discardKey = `discard:${rowKey}`;
    const pending = pendingKey === rowKey;
    const busy = !canWrite || pendingKey !== null || committing || generatingMessage;
    // 行内操作要走仓库相对路径：workdir 是仓库子目录时两者不同。
    const target: ReviewFileTarget = { path: change.repoPath, oldPath: change.oldPath, source };
    return (
      <div
        key={rowKey}
        role="button"
        tabIndex={0}
        onClick={() => onSelectFile(path)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onSelectFile(path);
        }}
        className={cn(
          'group/changed-file relative flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left',
          'text-12 text-[var(--text-primary)] hover:bg-sidebar-item-hover',
          selectedPath === path && 'bg-sidebar-item-active',
        )}
      >
        <Icon
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-[var(--text-secondary)]"
          style={statusColor ? { color: statusColor } : undefined}
        />
        <span
          className="min-w-0 truncate"
          style={statusColor ? { color: statusColor } : undefined}
        >
          {name}
        </span>
        {directory && (
          <span className="min-w-0 truncate text-10 text-[var(--text-tertiary)]">
            {directory}
          </span>
        )}
        <span
          className="ml-auto shrink-0 text-11 font-medium"
          style={{ color: visual.color }}
        >
          {visual.code}
        </span>
        <span className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-[var(--surface-elevated)] pl-1 group-hover/changed-file:flex group-focus-within/changed-file:flex">
          <Tip
            text={
              source === 'unstaged'
                ? t('rightSidebar.review.actions.stage')
                : t('rightSidebar.review.actions.unstage')
            }
          >
            <button
              type="button"
              aria-label={
                source === 'unstaged'
                  ? t('rightSidebar.review.actions.stage')
                  : t('rightSidebar.review.actions.unstage')
              }
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void applyStage(source === 'unstaged' ? 'stage' : 'unstage', [target], rowKey);
              }}
              className="flex size-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40"
            >
              {pending ? (
                <Spinner size={12} />
              ) : source === 'unstaged' ? (
                <Plus size={12} />
              ) : (
                <Minus size={12} />
              )}
            </button>
          </Tip>
          {source === 'unstaged' && (
            <Tip text={t('rightSidebar.review.actions.discard')}>
              <button
                type="button"
                aria-label={t('rightSidebar.review.actions.discard')}
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  void revert([target], discardKey, 'file');
                }}
                className="flex size-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40"
              >
                {pendingKey === discardKey ? <Spinner size={12} /> : <Undo2 size={12} />}
              </button>
            </Tip>
          )}
        </span>
      </div>
    );
  };

  const renderSectionHeader = (
    label: string,
    count: number,
    action: 'stage' | 'unstage',
    targets: string[],
  ) => {
    const key = `bulk:${action}`;
    const pending = pendingKey === key;
    return (
      <div className="flex h-7 items-center gap-1 px-2 text-10 font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
        <span>{label}</span>
        <span>{count}</span>
        <Tip
          text={
            action === 'stage'
              ? t('rightSidebar.review.actions.stageAll')
              : t('rightSidebar.review.actions.unstageAll')
          }
        >
          <button
            type="button"
            aria-label={
              action === 'stage'
                ? t('rightSidebar.review.actions.stageAll')
                : t('rightSidebar.review.actions.unstageAll')
            }
            disabled={
              !canWrite ||
              targets.length === 0 ||
              pendingKey !== null ||
              committing ||
              generatingMessage
            }
            onClick={() =>
              void applyStage(
                action,
                targets.map((path) => ({
                  path,
                  oldPath: changes.get(path)?.oldPath ?? null,
                  source: action === 'stage' ? 'unstaged' : 'staged',
                })),
                key,
              )
            }
            className="ml-auto flex size-5 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40"
          >
            {pending ? (
              <Spinner size={11} />
            ) : action === 'stage' ? (
              <Plus size={11} />
            ) : (
              <Minus size={11} />
            )}
          </button>
        </Tip>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 px-3 text-12">
        <span className="font-medium text-[var(--text-primary)]">
          {t('rightSidebar.fileBrowser.changes')}
        </span>
        <span className="rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-10 text-[var(--text-secondary)]">
          {visiblePaths.length}
        </span>
        {loading && <Spinner size={11} />}
        <Tip text={t('rightSidebar.review.actions.discardAll')}>
          <button
            type="button"
            aria-label={t('rightSidebar.review.actions.discardAll')}
            disabled={
              !canWrite ||
              changes.size === 0 ||
              pendingKey !== null ||
              committing ||
              generatingMessage
            }
            onClick={() => {
              const targets = [...changes.values()].flatMap(targetsForChange);
              void revert(targets, 'all', 'section');
            }}
            className="ml-auto flex size-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40"
          >
            {pendingKey === 'all' ? <Spinner size={12} /> : <Undo2 size={12} />}
          </button>
        </Tip>
      </div>

      {error && (
        <div className="px-3 py-2 text-11 text-[hsl(var(--destructive))]">{error}</div>
      )}
      {behind > 0 && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--warning-bg-soft)] px-2.5 py-2 text-11 leading-relaxed text-[var(--text-secondary)]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--warning-fg)]" />
          <span className="min-w-0 flex-1">
            {diverged
              ? t('rightSidebar.fileBrowser.remoteDiverged', { ahead, behind })
              : t('rightSidebar.fileBrowser.remoteBehind', { count: behind })}
          </span>
          <Button
            variant="secondary"
            size="xs"
            compact
            type="button"
            loading={pulling}
            disabled={!canWrite || committing || generatingMessage}
            onClick={() => void pullUpdates()}
          >
            {t('rightSidebar.fileBrowser.pull')}
          </Button>
        </div>
      )}
      {behind === 0 && ahead > 0 && (
        <div className="px-3 pb-1 text-11 text-[var(--text-tertiary)]">
          {t('rightSidebar.fileBrowser.localAhead', { count: ahead })}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {visibleUnstagedPaths.length > 0 && (
          <>
            {renderSectionHeader(
              t('rightSidebar.fileBrowser.unstagedGroup'),
              visibleUnstagedPaths.length,
              'stage',
              unstagedPaths,
            )}
            {visibleUnstagedPaths.map((path) => renderRow(path, 'unstaged'))}
          </>
        )}
        {visibleStagedPaths.length > 0 && (
          <>
            {renderSectionHeader(
              t('rightSidebar.fileBrowser.stagedGroup'),
              visibleStagedPaths.length,
              'unstage',
              stagedPaths,
            )}
            {visibleStagedPaths.map((path) => renderRow(path, 'staged'))}
          </>
        )}
        {!loading && !error && visiblePaths.length === 0 && (
          <div className="flex h-full items-center justify-center px-4 text-center text-12 text-[var(--text-tertiary)]">
            {t('rightSidebar.fileBrowser.changedOnlyEmpty')}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-[var(--border-default)]">
        <button
          type="button"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((value) => !value)}
          className="flex h-7 w-full items-center gap-1.5 px-3 text-12 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <History size={12} className="shrink-0" />
          <span>{t('rightSidebar.fileBrowser.history')}</span>
          <span className="text-10 text-[var(--text-tertiary)]">
            {history?.commits.length ?? 0}
          </span>
          {historyLoading && <Spinner size={11} />}
          <ChevronDown
            size={12}
            className={cn(
              'ml-auto shrink-0 transition-transform',
              !historyOpen && '-rotate-90',
            )}
          />
        </button>
        {historyOpen && (
          <div className="max-h-40 overflow-y-auto px-1 pb-1">
            {(history?.commits.length ?? 0) === 0 ? (
              <div className="px-2 py-2 text-11 text-[var(--text-tertiary)]">
                {t('rightSidebar.fileBrowser.historyEmpty')}
              </div>
            ) : (
              history?.commits.map((commit, index) => {
                const upstreamIndex = history.upstreamOid
                  ? history.commits.findIndex((item) => item.oid === history.upstreamOid)
                  : -1;
                const unpushed =
                  ahead > 0 &&
                  upstream !== null &&
                  (upstreamIndex >= 0
                    ? index < upstreamIndex
                    : index < Math.min(ahead, history.commits.length));
                return (
                  <button
                    key={commit.oid}
                    type="button"
                    title={commit.title}
                    onClick={() => {
                      if (sessionId) void openCommitReview(sessionId, commit.oid);
                    }}
                    className="flex h-7 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-11 hover:bg-sidebar-item-hover"
                  >
                    <span className="shrink-0 font-mono text-10 text-[var(--text-tertiary)]">
                      {commit.shortOid}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                      {commit.title}
                    </span>
                    {unpushed && (
                      <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-1 text-10 text-[var(--text-secondary)]">
                        {t('rightSidebar.fileBrowser.historyUnpushed')}
                      </span>
                    )}
                    <span className="shrink-0 text-10 text-[var(--text-tertiary)]">
                      {relativeTime(new Date(commit.authorTime * 1_000).toISOString(), t)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
      {operationError && (
        <ErrorNotice
          role="alert"
          className="mx-3 mb-2"
          message={operationError.title}
          description={operationError.message}
          onDismiss={() => setOperationError(null)}
        />
      )}
      <div className="shrink-0 border-t border-[var(--border-default)] px-3 py-2">
        <textarea
          value={commitMessage}
          onChange={(event) => {
            commitMessageDirtyRef.current = true;
            setCommitMessage(event.target.value);
          }}
          aria-label={t('rightSidebar.fileBrowser.commitMessage')}
          placeholder={t('rightSidebar.fileBrowser.commitMessagePlaceholder')}
          rows={4}
          disabled={!canWrite || committing || generatingMessage}
          className="min-h-[76px] w-full resize-none rounded-[8px] border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-2 text-11 leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)] disabled:opacity-60"
        />
        <div className="mb-2 flex min-w-0 items-center gap-2 text-11 text-[var(--text-secondary)]">
          <label className="flex shrink-0 cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={autoPush}
              disabled={!canWrite || committing || generatingMessage}
              onChange={(event) => {
                const checked = event.target.checked;
                setAutoPush(checked);
                try {
                  window.localStorage.setItem(AUTO_PUSH_STORAGE_KEY, String(checked));
                } catch {
                  // Keep the in-memory preference when local storage is unavailable.
                }
              }}
              className="size-3.5 shrink-0 accent-[var(--accent-cta-bg-pure)]"
            />
            <span>{t('rightSidebar.fileBrowser.autoPush')}</span>
          </label>
          {branchWebUrl ? (
            <button
              type="button"
              className="-my-1 ml-auto flex min-w-0 items-center gap-1 rounded-full px-1 py-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
              title={t('rightSidebar.fileBrowser.pushBranch', { branch: pushBranch })}
              onClick={() => void window.electronAPI.openExternal(branchWebUrl)}
            >
              <GitBranch size={11} className="shrink-0" />
              <span className="truncate">
                {t('rightSidebar.fileBrowser.pushBranch', { branch: pushBranch })}
              </span>
            </button>
          ) : (
            <span
              className="ml-auto flex min-w-0 items-center gap-1 text-[var(--text-tertiary)]"
              title={t('rightSidebar.fileBrowser.pushBranch', { branch: pushBranch })}
            >
              <GitBranch size={11} className="shrink-0" />
              <span className="truncate">
                {t('rightSidebar.fileBrowser.pushBranch', { branch: pushBranch })}
              </span>
            </span>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button
            variant="secondary"
            size="xs"
            compact
            type="button"
            aria-label={t('rightSidebar.fileBrowser.aiCommitSummary')}
            loading={generatingMessage}
            disabled={!canWrite || changes.size === 0}
            onClick={() => void generateAiMessage()}
          >
            <Sparkles size={11} />
            <span>{t('rightSidebar.fileBrowser.aiCommitSummary')}</span>
          </Button>
          <Button
            variant="cta"
            size="sm"
            className="min-w-0 flex-1"
            type="button"
            aria-label={t('rightSidebar.fileBrowser.commitToGithub')}
            loading={committing}
            disabled={
              !canWrite ||
              changes.size === 0 ||
              !commitMessage.trim() ||
              generatingMessage ||
              commitBlocked
            }
            onClick={() => void commitChanges()}
          >
            {t('rightSidebar.fileBrowser.commitToGithub')}
          </Button>
        </div>
      </div>
    </div>
  );
}

async function discardFileChanges(
  sessionId: string,
  targets: ReviewFileTarget[],
): Promise<ReviewStageOperationResult> {
  const stagedTargets = targets.filter((target) => target.source === 'staged');
  const unstaged = stagedTargets.length
    ? await window.electronAPI.gitReview.unstageAll({ sessionId, targets: stagedTargets })
    : null;
  const touchedPaths = new Set<string>();
  for (const target of targets) {
    touchedPaths.add(target.path);
    if (target.oldPath) touchedPaths.add(target.oldPath);
  }
  const unstagedTargets: ReviewFileTarget[] = unstaged
    ? (unstaged.data.status?.files ?? []).flatMap((file) =>
        file.sources.includes('unstaged') &&
        (touchedPaths.has(file.path) || (file.oldPath && touchedPaths.has(file.oldPath)))
          ? [{ path: file.path, oldPath: file.oldPath, source: 'unstaged' as const }]
          : [],
      )
    : targets.filter((target) => target.source === 'unstaged');

  if (unstagedTargets.length === 0) {
    if (!unstaged) throw new Error('no file changes to discard');
    return unstaged;
  }
  const discarded = await window.electronAPI.gitReview.discardAll({
    sessionId,
    targets: unstagedTargets,
  });
  if (!unstaged) return discarded;

  const failed = [...unstaged.operation.failed, ...discarded.operation.failed];
  return {
    data: discarded.data,
    operation: {
      action: 'discard',
      succeeded: Array.from(
        new Set([...unstaged.operation.succeeded, ...discarded.operation.succeeded]),
      ),
      failed,
      partial: failed.length > 0,
    },
  };
}

function targetsForChange(change: WorkdirGitFileChange): ReviewFileTarget[] {
  // git 操作要求仓库相对路径：workdir 是仓库子目录时 change.path 会少掉前缀。
  const targets: ReviewFileTarget[] = [];
  if (change.unstaged) {
    targets.push({ path: change.repoPath, oldPath: change.oldPath, source: 'unstaged' });
  }
  if (change.staged) {
    targets.push({ path: change.repoPath, oldPath: change.oldPath, source: 'staged' });
  }
  return targets;
}
