import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { NavigateFunction } from 'react-router-dom';
import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';
import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import { makerChatStore } from '@/lib/makerChatStore';
import { countDirtyWorktreesForRemoval } from '@/lib/worktreeRemovalWarning';
import { archiveScheduleWarningMany } from '@/features/scheduler/lib/archiveScheduleWarning';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { isRemoteSessionWriteBlocked } from '../lib/remoteSessionWriteGuard';

const log = createLogger('CCAgentSidebarUpper');
interface Options {
  bulkActionPending: 'archive' | 'delete' | null;
  selectedSessions: readonly Session[];
  runningSessionIds: ReadonlySet<string>;
  confirmDialog: (options: ConfirmOptions) => Promise<boolean>;
  patchLocal: (id: string, patch: Partial<Session>) => void;
  refreshSessions: () => Promise<unknown>;
  viewedSessionId: string | null | undefined;
  navigate: NavigateFunction;
  setBulkActionPending: Dispatch<SetStateAction<'archive' | 'delete' | null>>;
  setSelectedSessionIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorSessionId: Dispatch<SetStateAction<string | null>>;
}

/** Sidebar selection archive; kept separate so its commit/cleanup path is tested
 * with the same confirmation, target routing and partial-failure behavior as UI. */
export function useBulkSessionArchive({
  bulkActionPending, selectedSessions, runningSessionIds, confirmDialog,
  patchLocal, refreshSessions, viewedSessionId, navigate, setBulkActionPending,
  setSelectedSessionIds, setSelectionAnchorSessionId,
}: Options) {
  const { t } = useTranslation();
  return useCallback(async () => {
    if (bulkActionPending !== null) return;
    if (selectedSessions.some(isRemoteSessionWriteBlocked)) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    const skippedNotActive = selectedSessions.filter(
      (session) => session.status !== 'active',
    ).length;
    const skippedRunning = selectedSessions.filter(
      (session) => session.status === 'active' && runningSessionIds.has(session.id),
    ).length;
    const preflightCandidates = selectedSessions.filter(
      (session) => session.status === 'active' && !runningSessionIds.has(session.id),
    );
    const attachedIds = new Set(
      (
        await Promise.all(
          preflightCandidates.map(async (session) => {
            try {
              const binding = await window.electronAPI.binding.resolveSession(session.id);
              return binding.attached ? session.id : null;
            } catch {
              // resolveSession 失败时与单条归档一致:不阻断归档。
              return null;
            }
          }),
        )
      ).filter((id): id is string => id != null),
    );
    const candidates = preflightCandidates.filter((session) => !attachedIds.has(session.id));

    if (candidates.length === 0) {
      toast.warning(t('ccAgent.sidebar.bulkSelection.archiveNone'));
      return;
    }

    const scheduleWarning = await archiveScheduleWarningMany(t, candidates);
    const dirtyCount = await countDirtyWorktreesForRemoval(candidates);

    const skipNotes: string[] = [];
    if (skippedRunning > 0)
      skipNotes.push(t('ccAgent.sidebar.bulkSelection.skipRunning', { count: skippedRunning }));
    if (attachedIds.size > 0)
      skipNotes.push(t('ccAgent.sidebar.bulkSelection.skipAttached', { count: attachedIds.size }));
    if (skippedNotActive > 0)
      skipNotes.push(t('ccAgent.sidebar.bulkSelection.skipNotActive', { count: skippedNotActive }));
    const baseDescription =
      skipNotes.length > 0
        ? t('ccAgent.sidebar.bulkSelection.confirmArchive.descriptionWithSkip', {
            count: candidates.length,
            skip: skipNotes.join(t('ccAgent.sidebar.bulkSelection.skipSeparator')),
          })
        : t('ccAgent.sidebar.bulkSelection.confirmArchive.description', {
            count: candidates.length,
          });
    const description =
      baseDescription +
      (dirtyCount > 0
        ? ' ' +
          t('ccAgent.sidebar.bulkSelection.confirmArchive.dirtyWorktreeWarning', {
            count: dirtyCount,
          })
        : '') +
      (scheduleWarning ? ' ' + scheduleWarning : '');

    const ok = await confirmDialog({
      title: t('ccAgent.sidebar.bulkSelection.confirmArchive.title'),
      description,
      confirmText: t('ccAgent.sidebar.bulkSelection.confirmArchive.confirm'),
      cancelText: t('ccAgent.sidebar.bulkSelection.confirmArchive.cancel'),
    });
    if (!ok) return;

    setBulkActionPending('archive');
    const failed: string[] = [];
    try {
      for (const session of candidates) {
        makerChatStore.closeSessionQuery(session.id);
        try {
          // 与单条归档共用同一目标判定,避免复制数据库后的 sticky sessionId 冲突
          // 被误送往已经关闭控制的设备。
          const statusWriteTarget = await sessionService.resolveStatusWriteTarget(session.id);
          await sessionService.setStatus(session.id, 'archived', statusWriteTarget);
          // 乐观本地 patch 只对本机会话;远程会话由隧道广播 sessions:patched → applyPatch 更新远程分片。
          if (statusWriteTarget.kind === 'local') {
            patchLocal(session.id, { status: 'archived', pinnedAt: null });
          }
          makerChatStore.purgeSession(session.id);
          // Archive is reversible: retain the unsent draft and staged attachments.
        } catch (err) {
          log.error('[bulk session archive]', err);
          failed.push(session.id);
        }
      }

      const failedIds = new Set(failed);
      const succeededIds = new Set(
        candidates.filter((session) => !failedIds.has(session.id)).map((session) => session.id),
      );
      await refreshSessions();

      if (viewedSessionId && succeededIds.has(viewedSessionId)) {
        navigate('/cc-agent');
      }

      setSelectedSessionIds((prev) => {
        const next = new Set(prev);
        for (const id of succeededIds) next.delete(id);
        return next;
      });
      setSelectionAnchorSessionId((prev) => (prev && succeededIds.has(prev) ? null : prev));

      if (failed.length === 0) {
        toast.success(t('ccAgent.sidebar.bulkSelection.archived', { count: succeededIds.size }));
      } else {
        toast.error(
          t('ccAgent.sidebar.bulkSelection.partialArchiveFailure', {
            ok: succeededIds.size,
            fail: failed.length,
          }),
        );
      }
    } finally {
      setBulkActionPending(null);
    }
  }, [
    viewedSessionId,
    bulkActionPending,
    confirmDialog,
    navigate,
    patchLocal,
    refreshSessions,
    runningSessionIds,
    selectedSessions,
    setBulkActionPending,
    setSelectedSessionIds,
    setSelectionAnchorSessionId,
    t,
  ]);

}
