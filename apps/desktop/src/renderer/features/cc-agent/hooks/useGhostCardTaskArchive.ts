import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  onGhostCardTaskArchiveRequest,
  takeGhostCardTaskSeen,
} from '@/cindy-brain/ghostCardTaskArchive';
import { getRemoteSessionActivity, isRemoteSessionActivityActive } from '@/features/device-link/remoteSessionActivityStore';
import { loadActiveBoundScheduleNames } from '@/features/scheduler/lib/archiveScheduleWarning';
import type { Session } from '@/lib/ccAgent.types';
import { makerChatStore } from '@/lib/makerChatStore';
import { toast } from '@/lib/toast';
import { resolveWorktreeRemovalPreflight } from '@/lib/worktreeRemovalWarning';

import { isSessionRemovalRouteCurrent } from '../lib/sessionRemovalNavigation';
import { useSessionLifecycleActions } from './useSessionLifecycleActions';

/**
 * 插件卡片上的归档任务按钮(见 cindy-brain/ghostCardTaskArchive)在任务页这一侧的处理。
 *
 * - 点按钮:用 archive(与标题栏、快捷键同一套归档流程,带确认)归档这个任务。
 * - 合并后自动归档:离开任务时,如果已合并的卡片在用户眼前显示过,而且这个任务没有在运行、
 *   没被接管、没绑着定时任务、worktree 确认干净,就静默归档,并给一个可撤销的提示。
 *   任一条件不满足都不归档,也不弹确认:任务留在列表里,用户下次看过再离开时重新判断。
 */
export function useGhostCardTaskArchive({
  session,
  archive,
  remoteWritesBlocked,
  autoArchive,
}: {
  session: Session | null;
  archive: () => Promise<void>;
  remoteWritesBlocked: boolean;
  /** 这个任务页离开时是否可以自动归档(普通任务页才可以)。 */
  autoArchive: boolean;
}): void {
  const { t } = useTranslation();
  const { runSessionAction, unarchiveSession } = useSessionLifecycleActions();
  const sessionId = session?.id ?? null;

  useEffect(() => {
    if (!sessionId) return;
    return onGhostCardTaskArchiveRequest((id) => {
      if (id === sessionId) void archive();
    });
  }, [archive, sessionId]);

  // 离开时(换任务或离开任务页)才归档:读的是离开那一刻的任务信息。
  const latest = useRef({ session, remoteWritesBlocked, runSessionAction, unarchiveSession, t });
  latest.current = { session, remoteWritesBlocked, runSessionAction, unarchiveSession, t };
  useEffect(() => {
    if (!sessionId || !autoArchive) return;
    return () => {
      if (!takeGhostCardTaskSeen(sessionId)) return;
      const { session: left, ...deps } = latest.current;
      if (left?.id === sessionId) void autoArchiveLeftTask(left, deps);
    };
  }, [sessionId, autoArchive]);
}

async function autoArchiveLeftTask(
  session: Session,
  { remoteWritesBlocked, runSessionAction, unarchiveSession, t }: {
    remoteWritesBlocked: boolean;
    runSessionAction: ReturnType<typeof useSessionLifecycleActions>['runSessionAction'];
    unarchiveSession: (sessionId: string) => Promise<void>;
    t: (key: string, options?: Record<string, unknown>) => string;
  },
): Promise<void> {
  const sessionId = session.id;
  const deviceId = session.deviceLinkDeviceId;
  if (remoteWritesBlocked || session.status !== 'active') return;
  // 先自己查运行状态:归档流程查到运行中会弹提示,自动归档应该什么都不说。
  if (makerChatStore.getRunningSnapshot().get(sessionId)?.isRunning ||
    (deviceId && isRemoteSessionActivityActive(getRemoteSessionActivity(sessionId, deviceId)))) return;
  const archived = await runSessionAction(sessionId, 'archive', {
    activeSessionId: null,
    prepareArchive: async (isCurrent) => {
      const attached = await window.electronAPI.binding
        .resolveSession(sessionId)
        .then((binding) => binding.attached)
        .catch(() => true);
      if (attached) return false;
      const scheduleNames =
        (await loadActiveBoundScheduleNames([{ id: sessionId, deviceLinkDeviceId: deviceId }])).get(sessionId) ?? [];
      if (scheduleNames.length > 0) return false;
      const preflight = await resolveWorktreeRemovalPreflight(sessionId, deviceId);
      // 检查期间用户又回到这个任务:不在眼前收走它。
      return preflight === 'clean' && isCurrent() && !isSessionRemovalRouteCurrent(sessionId);
    },
  });
  if (archived !== true) return;
  toast.success(t('chat.ghostCall.taskAutoArchived', { title: session.title }), {
    duration: 8000,
    action: { label: t('chat.ghostCall.taskAutoArchivedUndo'), onClick: () => { void unarchiveSession(sessionId); } },
  });
}
