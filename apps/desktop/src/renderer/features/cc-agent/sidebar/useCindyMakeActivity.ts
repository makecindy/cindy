import { useCallback, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { cindyMakeState } from '@/lib/cindyMakeState';
import type { Session } from '@/lib/ccAgent.types';
import { CINDY_MAKE_SESSION_SOURCE } from '../../../../shared/cindyMakeSession';
import type { CindyMakeTaskPreparation } from '../../../../shared/cindyMakeDoctor';

const idle = () => undefined;

export function useCindyMakeActivity(
  session: Session,
): CindyMakeTaskPreparation['phase'] | 'building' | undefined {
  const generation = getDataOwnerGeneration();
  const enabled =
    session.source === CINDY_MAKE_SESSION_SOURCE &&
    !session.deviceLinkDeviceId &&
    !session.remoteHostId &&
    session.status !== 'archived' &&
    session.status !== 'deleted';
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? cindyMakeState.subscribe(listener) : idle),
    [enabled, generation.dataOwnerId, generation.generation],
  );
  // Rows select a primitive for their own task: package counters and other tasks'
  // progress must not redraw the entire sidebar on every installation update.
  const getSnapshot = useCallback(() => {
    if (!enabled) return undefined;
    if (cindyMakeState.getSnapshot().personalBuildSessionIds?.includes(session.id))
      return 'building';
    const report = cindyMakeState.taskForSession(session.id);
    return report?.status === 'running' ? report.task?.phase : undefined;
  }, [enabled, session.id]);
  return useSyncExternalStore(subscribe, getSnapshot, idle);
}
