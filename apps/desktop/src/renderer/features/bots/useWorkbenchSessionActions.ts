import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Session } from '@/lib/ccAgent.types';
import { useSessionLifecycleActions } from '@/features/cc-agent/hooks/useSessionLifecycleActions';
import { useSessionRunningStatus } from '@/hooks/useSessionRunningStatus';
import { useAttachedSessionIds } from '@/hooks/useAttachedSessionIds';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { resolveWorktreeRemovalPreflight } from '@/lib/worktreeRemovalWarning';
import { sessionsStore } from '@/lib/sessionsStore';
import * as service from '@/lib/sessionService';
import { isRemoteSessionWriteBlocked } from '@/features/cc-agent/lib/remoteSessionWriteGuard';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { persistManualPinnedOrder } from '@/features/cc-agent/hooks/helpers/sidebarFilterCore';
import { toast } from '@/lib/toast';

export type WorkbenchSessionActionKind = 'archive' | 'unarchive' | 'delete';

/**
 * 工作台条目「…」里的任务操作:与任务侧栏同一套生命周期 API 与守卫(运行中 / 被终端占用时
 * 不归档、worktree 有改动或未知时先确认、共享任务先关闭共享),本身不持有任何任务状态。
 * 打开只是看,不恢复归档;恢复只走明确的「恢复」。
 */
export function useWorkbenchSessionActions(sessions: readonly Session[], onChanged: () => void) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const { clearNotification } = useSessionRunningStatus(undefined);
  const attached = useAttachedSessionIds();
  const { runSessionAction, unarchiveSession, archiveBlockedByRunning } = useSessionLifecycleActions({ includeArchived: 'all' });
  const byId = useMemo(() => new Map(sessions.map((row) => [row.id, row])), [sessions]);

  const open = useCallback(
    (id: string) => {
      clearNotification(id);
      void resolveSessionRoute(id, byId.get(id)).then((route) => navigate(route));
    },
    [byId, clearNotification, navigate],
  );

  const action = useCallback(
    async (id: string, kind: WorkbenchSessionActionKind, sharedTaskId?: string) => {
      try {
        if (isRemoteSessionWriteBlocked(byId.get(id))) {
          toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
          return;
        }
        if (kind === 'unarchive') {
          await unarchiveSession(id);
          onChanged();
          return;
        }
        const archive = kind === 'archive';
        if (archive && archiveBlockedByRunning(id, byId.get(id)?.deviceLinkDeviceId)) return;
        if (
          archive &&
          (attached.has(id) ||
            (await window.electronAPI.binding.resolveSession(id).catch(() => ({ attached: false }))).attached)
        ) {
          toast.warning(t('ccAgent.sidebar.archiveBlocked.attached'));
          return;
        }
        const preflight = await resolveWorktreeRemovalPreflight(id, byId.get(id)?.deviceLinkDeviceId);
        const prefix = archive ? 'ccAgent.sidebar.confirmArchive' : 'ccAgent.sidebar.confirmDelete';
        if (
          (!archive || preflight !== 'clean') &&
          !(await confirm({
            title: t(prefix + '.title'),
            description:
              t(prefix + '.description') + (preflight === 'dirty' ? ' ' + t(prefix + '.dirtyWorktreeWarning') : ''),
            confirmText: t(prefix + '.confirm'),
            cancelText: t(prefix + '.cancel'),
          }))
        )
          return;
        if (archive && archiveBlockedByRunning(id, byId.get(id)?.deviceLinkDeviceId)) return;
        if (sharedTaskId) {
          const result = (await window.electronAPI.sharedTask.account({ action: 'close', sharedTaskId })) as {
            closed?: string[];
          };
          if (!result.closed?.includes(sharedTaskId)) {
            toast.error(t('sharedTask.closeFailedToast', { count: 1 }));
            return;
          }
        }
        await runSessionAction(id, archive ? 'archive' : 'delete', { activeSessionId: null });
        onChanged();
      } catch {
        toast.error(t(kind === 'delete' ? 'ccAgent.sidebar.deleteFailed' : 'ccAgent.sidebar.archiveFailed'));
      }
    },
    [byId, attached, confirm, onChanged, runSessionAction, archiveBlockedByRunning, t, unarchiveSession],
  );

  const togglePin = useCallback(
    async (id: string) => {
      const row = byId.get(id);
      if (!row) return;
      if (isRemoteSessionWriteBlocked(row)) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      const pinned = Boolean(row.pinnedAt);
      const owner = getDataOwnerGeneration();
      try {
        const patch = { pinnedAt: pinned ? null : new Date().toISOString() };
        await service.patchMeta(id, patch);
        sessionsStore.patchLocal(id, pinned ? { ...patch, summary: null } : patch);
        if (!pinned) {
          await persistManualPinnedOrder(
            { kind: 'promote', entryId: id },
            { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation },
          );
        }
        onChanged();
      } catch {
        toast.error(t('ccAgent.sidebar.pinFailed'));
      }
    },
    [byId, onChanged, t],
  );

  return { open, action, togglePin, byId };
}
