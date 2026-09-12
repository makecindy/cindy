import { useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  getRemoteSessionActivity,
  useRemoteSessionActivityRevision,
} from '@/features/device-link/remoteSessionActivityStore';
import { makerChatStore } from '@/lib/makerChatStore';
import { useCCSessions } from '@/hooks/useCCSessions';
import {
  useRemoteProjectSessions,
  useRemoteScheduleIndex,
} from '@/features/device-link/remoteProjectsStore';
import { usePublishedAutomationScheduleSessionIndex } from '@/features/cc-agent/hooks/useAutomationScheduleSessionIndex';
import { useSessionAttentionKinds } from '@/lib/sessionAttentionStore';
import { useAgentIslandActivityMap } from '@/state/agentIslandActivity';
import { createLogger } from '@/lib/logger';
import { countAppAttention } from '@/features/cc-agent/lib/appAttentionCount';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useAuth } from '@/contexts/AuthContext';
import { useSessionDisplayRunningState } from '@/features/cc-agent/hooks/useSessionDisplayRunningState';

const log = createLogger('AppBadgeAttentionSync');

/** 主窗口常驻：设置/伙伴页也持续更新，独立订阅避免带动布局重渲染。 */
export function AppBadgeAttentionSync() {
  useAuth();
  const owner = getDataOwnerGeneration();
  const { sessions, isLoading, error } = useCCSessions({ includeArchived: 'all' });
  const remoteSessions = useRemoteProjectSessions();
  const allSessions = useMemo(() => [...sessions, ...remoteSessions], [sessions, remoteSessions]);
  const localSchedules = usePublishedAutomationScheduleSessionIndex();
  const remoteSchedules = useRemoteScheduleIndex();
  const attentionKinds = useSessionAttentionKinds();
  const localActivities = useAgentIslandActivityMap();
  useRemoteSessionActivityRevision();
  const running = useSyncExternalStore(
    makerChatStore.subscribeAll,
    makerChatStore.getRunningSnapshot,
    makerChatStore.getRunningSnapshot,
  );
  const runningSessionIds = useMemo(
    () => new Set([...running].filter(([, info]) => info.isRunning).map(([id]) => id)),
    [running],
  );
  const { displayRunningSessionIds } = useSessionDisplayRunningState(
    allSessions,
    runningSessionIds,
  );
  const count = countAppAttention({
    sessions: allSessions,
    localSchedules,
    remoteSchedules,
    attentionKinds,
    localActivities,
    getRemoteActivity: getRemoteSessionActivity,
    runningSessionIds: displayRunningSessionIds,
  });
  useEffect(() => {
    if (isLoading || error) return;
    void window.electronAPI
      .notificationSetAppAttentionCount({
        count,
        sessionIds: allSessions.map((session) => session.id),
        dataOwnerId: owner.dataOwnerId,
        ownerGeneration: owner.generation,
      })
      .catch((err: unknown) => {
        log.warn('failed to update app attention count', err);
      });
    // 卸载/切路由不是已读，不清图标；下次挂载会重新提交完整投影。
  }, [count, isLoading, error, allSessions, owner]);
  return null;
}
