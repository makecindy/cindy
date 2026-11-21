import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Sparkles, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type {
  ReviewData,
  ReviewFileTarget,
  ReviewStageOperationResult,
} from '@/lib/gitReview.types';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { buildDeterministicCommitMessage } from '../../../../shared/gitCommitMessage';
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
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [generatingMessage, setGeneratingMessage] = useState(false);
  const deterministicMessage = useMemo(() => buildDeterministicCommitMessage(data), [data]);
  const [commitMessage, setCommitMessage] = useState(deterministicMessage);
  const commitMessageDirtyRef = useRef(false);
  useEffect(() => {
    if (!commitMessageDirtyRef.current) setCommitMessage(deterministicMessage);
  }, [deterministicMessage]);
  useEffect(() => {
    // 打开「已更改」就重读一次：只靠窗口 focus / 手动刷新会漏掉应用内保存的文件。
    onRefresh?.();
    // 只在面板打开时触发一次，不随 onRefresh 身份变化重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const paths = useMemo(() => [...changes.keys()].sort(), [changes]);
  const visiblePaths = useMemo(
    () => (query.trim() ? filterFiles(query, paths, 1_000) : paths),
    [paths, query],
  );
  const canWrite = Boolean(
    sessionId &&
      !deviceId &&
      data &&
      data.status?.writeDisabledReasons.length === 0,
  );
  const pushBranch = data?.scope.isDetached
    ? data.scope.headOid
      ? t('rightSidebar.review.detachedHead', { oid: data.scope.headOid.slice(0, 7) })
      : t('rightSidebar.review.branchUnknown')
    : data?.scope.branch || t('rightSidebar.review.branchUnknown');
  const branchWebUrl = data?.scope.branchWebUrl ?? null;
  const ahead = data?.scope?.aheadBehind?.ahead ?? 0;

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
      const draft = await window.electronAPI.gitReview.commitMessage({ sessionId });
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
    setCommitting(true);
    setPushError(null);
    let committed = false;
    try {
      const result = await window.electronAPI.gitReview.commit({
        sessionId,
        message,
        includeUnstaged: true,
      });
      committed = true;
      commitMessageDirtyRef.current = false;
      onGitStateChanged();
      toast.success(
        t('rightSidebar.fileBrowser.commitSuccess', { oid: result.commitOid.slice(0, 8) }),
      );
      if (!autoPush) return;
      await runPush();
    } catch (err) {
      const message = extractIpcError(err)?.message ?? String(err);
      if (committed) setPushError(message);
      else toast.error(message);
    } finally {
      setCommitting(false);
    }
  };

  /** 推送（含强制推送确认）。提交后自动推送与「单独推送」共用这段。 */
  const runPush = async () => {
    if (!sessionId) return;
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
  };

  /** 提交成功但推送失败、或事后才勾「自动 push」时的重试入口。 */
  const pushNow = async () => {
    if (!sessionId || !canWrite || pushing) return;
    setPushing(true);
    setPushError(null);
    try {
      await runPush();
    } catch (err) {
      setPushError(extractIpcError(err)?.message ?? String(err));
    } finally {
      setPushing(false);
    }
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
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {visiblePaths.map((path) => {
          const change = changes.get(path);
          if (!change) return null;
          const slash = path.lastIndexOf('/');
          const name = slash < 0 ? path : path.slice(slash + 1);
          const directory = slash < 0 ? '' : path.slice(0, slash);
          const Icon = pickFileIcon(name);
          const visual = WORKDIR_GIT_STATUS_VISUAL[change.kind];
          const statusColor = selectedPath === path ? undefined : visual.color;
          const rowKey = `file:${path}`;
          return (
            <div
              key={path}
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
                <Tip text={t('rightSidebar.review.actions.discard')}>
                  <button
                    type="button"
                    aria-label={t('rightSidebar.review.actions.discard')}
                    disabled={
                      !canWrite || pendingKey !== null || committing || generatingMessage
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      void revert(targetsForChange(change), rowKey, 'file');
                    }}
                    className="flex size-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40"
                  >
                    {pendingKey === rowKey ? <Spinner size={12} /> : <Undo2 size={12} />}
                  </button>
                </Tip>
              </span>
            </div>
          );
        })}
        {!loading && !error && visiblePaths.length === 0 && (
          <div className="flex h-full items-center justify-center px-4 text-center text-12 text-[var(--text-tertiary)]">
            {t('rightSidebar.fileBrowser.changedOnlyEmpty')}
          </div>
        )}
      </div>
      {pushError && (
        <ErrorNotice
          role="alert"
          className="mx-3 mb-2"
          message={t('rightSidebar.review.push.failedTitle')}
          description={pushError}
          onDismiss={() => setPushError(null)}
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
            disabled={!canWrite || changes.size === 0 || !commitMessage.trim() || generatingMessage}
            onClick={() => void commitChanges()}
          >
            {t('rightSidebar.fileBrowser.commitToGithub')}
          </Button>
          {ahead > 0 && (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              aria-label={t('rightSidebar.fileBrowser.pushBranch', { branch: pushBranch ?? '' })}
              loading={pushing}
              disabled={!canWrite}
              onClick={() => void pushNow()}
            >
              {t('rightSidebar.fileBrowser.pushNow')}
            </Button>
          )}
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
