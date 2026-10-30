import { useMemo } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import { useBackgroundActivitySessionIds } from '@/lib/sessionBackgroundActivityStore';
import { useStartingSessionIds } from '@/lib/sessionStartingStore';
import { useCindyMakeRunningSessionIds } from '@/lib/cindyMakeState';
import { useOrcaLeadWorkerMap } from './useOrcaLeadWorkerMap';

/** 列表、折叠栏和系统角标共享显示口径；后台/启动中不扩大操作拦截范围。 */
export function useSessionDisplayRunningState(
  sessions: readonly Session[],
  runningSessionIds: ReadonlySet<string>,
) {
  const orcaLeadWorkerMap = useOrcaLeadWorkerMap(sessions);
  const backgroundActivitySessionIds = useBackgroundActivitySessionIds();
  const startingSessionIds = useStartingSessionIds(runningSessionIds);
  const cindyMakeRunningSessionIds = useCindyMakeRunningSessionIds();
  const effectiveRunningSessionIds = useMemo(() => {
    const next = new Set(runningSessionIds);
    for (const [leadSessionId, workerSessionIds] of orcaLeadWorkerMap) {
      if ([...workerSessionIds].some((id) => runningSessionIds.has(id))) next.add(leadSessionId);
    }
    return next;
  }, [orcaLeadWorkerMap, runningSessionIds]);
  const displayRunningSessionIds = useMemo(() => {
    if (
      backgroundActivitySessionIds.size === 0 &&
      startingSessionIds.size === 0 &&
      cindyMakeRunningSessionIds.size === 0
    ) {
      return effectiveRunningSessionIds;
    }
    const next = new Set(effectiveRunningSessionIds);
    for (const id of backgroundActivitySessionIds) next.add(id);
    for (const id of startingSessionIds) next.add(id);
    for (const session of sessions) {
      if (
        session.source === 'cindy-make' &&
        !session.deviceLinkDeviceId &&
        !session.remoteHostId &&
        session.status === 'active' &&
        cindyMakeRunningSessionIds.has(session.id)
      )
        next.add(session.id);
    }
    for (const [leadSessionId, workerSessionIds] of orcaLeadWorkerMap) {
      if (
        [...workerSessionIds].some(
          (id) => backgroundActivitySessionIds.has(id) || startingSessionIds.has(id),
        )
      ) {
        next.add(leadSessionId);
      }
    }
    return next;
  }, [
    effectiveRunningSessionIds,
    backgroundActivitySessionIds,
    startingSessionIds,
    cindyMakeRunningSessionIds,
    sessions,
    orcaLeadWorkerMap,
  ]);
  return { effectiveRunningSessionIds, displayRunningSessionIds };
}
