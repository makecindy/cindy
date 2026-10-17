import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';

import { makerChatStore } from '@/lib/makerChatStore';
import { useCCSessions } from '@/hooks/useCCSessions';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { usePublishedAutomationScheduleSessionIndex } from '@/features/cc-agent/hooks/useAutomationScheduleSessionIndex';
import { useSessionAttentionKinds } from '@/lib/sessionAttentionStore';
import { useAgentIslandActivityMap } from '@/state/agentIslandActivity';
import { createLogger } from '@/lib/logger';
import { countAppAttention } from '@/features/cc-agent/lib/appAttentionCount';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useAuth } from '@/contexts/AuthContext';
import { useSessionDisplayRunningState } from '@/features/cc-agent/hooks/useSessionDisplayRunningState';
import { useOrcaLeadWorkerAttention } from '@/features/cc-agent/lib/orcaLeadWorkerAttention';

import { useBotProfiles, useBotUnreadCounts } from '@/features/bots/botStore';
import { useBotGroupList } from '@/features/bots/botGroupStore';
import { isBotGroupUnread, subscribeBotReadState, getBotLastReadAtMap } from '@/features/bots/botReadState';
import { useBotUnreadSync } from '@/features/bots/useBotUnreadSync';
import { useRemoteBotSync, useRemoteBots } from '@/features/bots/useRemoteBots';
import { isRemoteBotUnread } from '@/features/bots/remoteBotRoster';
import { useCompanionCloud } from '@/features/bots/companionCloudStore';
import { cloudRemoteBots, withoutShadowedBots } from '@/features/bots/companionCloudPresentation';
import { publishNavigationAttention } from '@/lib/navigationAttentionStore';
const readRevision = () => JSON.stringify(getBotLastReadAtMap());
const log = createLogger('AppBadgeAttentionSync');

/** 主窗口常驻：设置/伙伴页也持续更新，独立订阅避免带动布局重渲染。 */
export function AppBadgeAttentionSync() {
  useAuth();
  useBotUnreadSync();
  useRemoteBotSync();
  const cloud = useCompanionCloud();
  // Count each companion once, where it runs (same rows as the teammate list).
  const allBots = useBotProfiles();
  const bots = useMemo(() => withoutShadowedBots(allBots, cloud), [allBots, cloud]);
  const unread = useBotUnreadCounts();
  const { groups } = useBotGroupList();
  const rosterRemoteBots = useRemoteBots();
  const remoteBots = useMemo(() => cloudRemoteBots(cloud, rosterRemoteBots), [cloud, rosterRemoteBots]);
  useSyncExternalStore(subscribeBotReadState, readRevision, readRevision);
  const localTeammates = bots.filter(bot => bot.status !== 'archived' && bot.status !== 'deleting' && !bot.hiddenAt && (unread[bot.id] ?? 0) > 0).length
    + groups.filter(group => !group.archived && isBotGroupUnread(group)).length;
  const teammates = localTeammates + remoteBots.filter(isRemoteBotUnread).length;
  const owner = getDataOwnerGeneration();
  const { sessions, isLoading, error } = useCCSessions({ includeArchived: 'active' });
  // all 桶保留已归档目录 ID 用于通知去重；不能让它的历史上限挤掉 active 桶。
  const history = useCCSessions({ includeArchived: 'all' });
  const remoteSessions = useSyncExternalStore(remoteProjectsStore.subscribe, remoteProjectsStore.getMergedRemoteSessions);
  const allSessions = useMemo(
    () => [...sessions, ...remoteSessions].filter(session => CINDY_MAKE_ENABLED || !isCindyMakeSource(session.source)),
    [sessions, remoteSessions],
  );
  const catalogSessionIds = useMemo(
    () => [...new Set([...sessions, ...remoteSessions, ...history.sessions]
      .map((session) => session.id).concat(bots.flatMap(bot => bot.sessions.map(session => session.id))))],
    [sessions, remoteSessions, history.sessions, bots],
  );
  const localSchedules = usePublishedAutomationScheduleSessionIndex();
  const attentionKinds = useSessionAttentionKinds();
  // Worker 的投影由下面的 useSessionDisplayRunningState 持有(本机全部活跃 Lead)。
  const orcaLeadWorkerAttention = useOrcaLeadWorkerAttention();
  const localActivities = useAgentIslandActivityMap();
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
    attentionKinds,
    localActivities,
    runningSessionIds: displayRunningSessionIds,
    orcaLeadWorkerAttention,
  });
  useEffect(() => {
    publishNavigationAttention({ tasks: count, teammates });
  }, [count, teammates, owner]);
  useEffect(() => {
    if (isLoading || error || history.isLoading || history.error) return;
    void window.electronAPI
      .notificationSetAppAttentionCount({
        count: count + localTeammates,
        sessionIds: catalogSessionIds,
        dataOwnerId: owner.dataOwnerId,
        ownerGeneration: owner.generation,
      })
      .catch((err: unknown) => {
        log.warn('failed to update app attention count', err);
      });
    // 卸载/切路由不是已读，不清图标；下次挂载会重新提交完整投影。
  }, [count, localTeammates, isLoading, error, history.isLoading, history.error, catalogSessionIds, owner]);
  return null;
}
