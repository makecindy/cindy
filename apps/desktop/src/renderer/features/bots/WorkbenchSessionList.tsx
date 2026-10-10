import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Session } from '@/lib/ccAgent.types';
import { SessionCard } from '@/features/cc-agent/sidebar/SessionCard';
import type { SessionMoveTarget } from '@/features/cc-agent/sidebar/sessionMoveTarget';
import { toStoredSessionTitle } from '@/features/cc-agent/lib/sessionDisplayTitle';
import { useSessionLifecycleActions } from '@/features/cc-agent/hooks/useSessionLifecycleActions';
import { useSessionDisplayRunningState } from '@/features/cc-agent/hooks/useSessionDisplayRunningState';
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

/** Same row and lifecycle APIs as the task sidebar; this view owns no task state. */
export function WorkbenchSessionList({
  sessions,
  onChanged,
}: {
  sessions: Session[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const { runningSessionIds, notifications, clearNotification } =
    useSessionRunningStatus(undefined);
  const attached = useAttachedSessionIds();
  const { displayRunningSessionIds } = useSessionDisplayRunningState(sessions, runningSessionIds);
  const { runSessionAction, unarchiveSession } = useSessionLifecycleActions({
    includeArchived: 'all',
  });
  const byId = useMemo(() => new Map(sessions.map((row) => [row.id, row])), [sessions]);
  const open = useCallback(
    (id: string) => {
      clearNotification(id);
      void resolveSessionRoute(id, byId.get(id)).then((route) => navigate(route));
    },
    [byId, clearNotification, navigate],
  );
  const action = useCallback(
    async (
      id: string,
      kind: 'archive' | 'archive-now' | 'unarchive' | 'delete',
      sharedTaskId?: string,
    ) => {
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
        const archive = kind !== 'delete';
        if (archive && runningSessionIds.has(id)) {
          toast.warning(t('ccAgent.sidebar.archiveBlocked.running'));
          return;
        }
        if (
          archive &&
          (attached.has(id) ||
            (await window.electronAPI.binding.resolveSession(id).catch(() => ({ attached: false })))
              .attached)
        ) {
          toast.warning(t('ccAgent.sidebar.archiveBlocked.attached'));
          return;
        }
        const preflight = await resolveWorktreeRemovalPreflight(
          id,
          byId.get(id)?.deviceLinkDeviceId,
        );
        const prefix = archive ? 'ccAgent.sidebar.confirmArchive' : 'ccAgent.sidebar.confirmDelete';
        if (
          (!archive || preflight !== 'clean') &&
          !(await confirm({
            title: t(prefix + '.title'),
            description:
              t(prefix + '.description') +
              (preflight === 'dirty' ? ' ' + t(prefix + '.dirtyWorktreeWarning') : ''),
            confirmText: t(prefix + '.confirm'),
            cancelText: t(prefix + '.cancel'),
          }))
        )
          return;
        if (sharedTaskId) {
          const result = (await window.electronAPI.sharedTask.account({
            action: 'close',
            sharedTaskId,
          })) as { closed?: string[] };
          if (!result.closed?.includes(sharedTaskId)) {
            toast.error(t('sharedTask.closeFailedToast', { count: 1 }));
            return;
          }
        }
        await runSessionAction(id, archive ? 'archive' : 'delete', { activeSessionId: null });
        onChanged();
      } catch {
        toast.error(
          t(kind === 'delete' ? 'ccAgent.sidebar.deleteFailed' : 'ccAgent.sidebar.archiveFailed'),
        );
      }
    },
    [byId, attached, confirm, onChanged, runSessionAction, runningSessionIds, t, unarchiveSession],
  );
  const rename = useCallback(
    async (id: string, title: string) => {
      const row = byId.get(id);
      if (!row) return;
      if (isRemoteSessionWriteBlocked(row)) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      try {
        const patch = { title: toStoredSessionTitle(row, title) };
        await service.patchMeta(id, patch);
        sessionsStore.patchLocal(id, patch);
        onChanged();
      } catch {
        toast.error(t('ccAgent.sidebar.renameFailed'));
      }
    },
    [byId, onChanged, t],
  );
  const pin = useCallback(
    async (id: string, pinned: boolean) => {
      if (isRemoteSessionWriteBlocked(byId.get(id))) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      const owner = getDataOwnerGeneration();
      try {
        const patch = { pinnedAt: pinned ? null : new Date().toISOString() };
        await service.patchMeta(id, patch);
        sessionsStore.patchLocal(id, pinned ? { ...patch, summary: null } : patch);
        if (!pinned)
          await persistManualPinnedOrder(
            { kind: 'promote', entryId: id },
            { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation },
          );
        onChanged();
      } catch {
        toast.error(t('ccAgent.sidebar.pinFailed'));
      }
    },
    [byId, onChanged, t],
  );
  const move = useCallback(
    async (id: string, target: SessionMoveTarget) => {
      const row = byId.get(id);
      if (row?.remoteHostId || row?.deviceLinkDeviceId) {
        toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectRemoteUnsupported'));
        return;
      }
      if (runningSessionIds.has(id)) {
        toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectRunningBlocked'));
        return;
      }
      try {
        if (
          (await window.electronAPI.binding.resolveSession(id).catch(() => ({ attached: false })))
            .attached
        ) {
          toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectAttachedBlocked'));
          return;
        }
        let workingDir = target.kind === 'project' ? target.workingDir : undefined;
        if (target.kind === 'browseProject') {
          const result = await window.electronAPI.showOpenDirectoryDialog();
          if (result.canceled || !result.path) return;
          workingDir = result.path;
        }
        if (target.kind !== 'dialogue' && !workingDir) return;
        const patch =
          target.kind === 'dialogue'
            ? { workspaceKind: 'dialogue' as const }
            : { workingDir, workspaceKind: 'project' as const };
        await service.update(id, patch);
        sessionsStore.patchLocal(id, patch);
        onChanged();
      } catch {
        toast.error(t('ccAgent.sidebar.sessionMenu.moveToProjectFailed'));
      }
    },
    [byId, onChanged, runningSessionIds, t],
  );
  const projectOptions = useMemo(
    () =>
      [
        ...new Set(
          sessions
            .filter((row) => !row.deviceLinkDeviceId && !row.remoteHostId)
            .map((row) => row.workingDir)
            .filter((path): path is string => Boolean(path)),
        ),
      ].map((path) => ({
        path,
        name: path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? path,
      })),
    [sessions],
  );
  return (
    <div className="px-3" data-workbench-session-list>
      {sessions.map((session, index) => (
        <SessionCard
          key={session.id}
          session={session}
          variant="list"
          isFirst={index === 0}
          isActive={false}
          isRunning={displayRunningSessionIds.has(session.id)}
          isAttached={attached.has(session.id)}
          hasAttentionNotification={notifications.has(session.id)}
          onClick={open}
          onAction={action}
          projectOptions={projectOptions}
          onRename={rename}
          onTogglePin={pin}
          onMoveSession={move}
        />
      ))}
    </div>
  );
}
