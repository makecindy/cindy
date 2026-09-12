import { useEffect, useSyncExternalStore } from 'react';

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

const log = createLogger('AppBadgeAttentionSync');

/** 主窗口常驻：设置/伙伴页也持续更新，独立订阅避免带动布局重渲染。 */
export function AppBadgeAttentionSync() {
  const { sessions, isLoading, error } = useCCSessions({ includeArchived: 'all' });
  const remoteSessions = useRemoteProjectSessions();
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
  const count = countAppAttention({
    sessions: [...sessions, ...remoteSessions],
    localSchedules,
    remoteSchedules,
    attentionKinds,
    localActivities,
    getRemoteActivity: getRemoteSessionActivity,
    runningSessionIds: new Set([...running].filter(([, info]) => info.isRunning).map(([id]) => id)),
  });
  useEffect(() => {
    if (isLoading || error) return;
    void window.electronAPI.notificationSetAppAttentionCount(count).catch((err: unknown) => {
      log.warn('failed to update app attention count', err);
    });
    // 卸载/切路由不是已读，不清图标；下次挂载会重新提交完整投影。
  }, [count, isLoading, error]);
  return null;
}
