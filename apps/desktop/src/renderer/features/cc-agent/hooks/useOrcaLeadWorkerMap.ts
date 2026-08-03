import { useMemo } from 'react';

import type { Session } from '@/lib/ccAgent.types';
import { isOrcaLeadSession } from '@/lib/orcaSessionIdentity';
import {
  getWorkerProjectionSnapshot,
  useWorkerProjectionOwners,
  useWorkerProjectionVersion,
} from './workerProjectionStore';

export function useOrcaLeadWorkerMap(
  sessions: readonly Session[],
): Map<string, ReadonlySet<string>> {
  const leadSessionIds = useMemo(
    () => sessions.filter(isOrcaLeadSession).map((s) => s.id),
    [sessions],
  );
  const leadSessionKey = useMemo(
    () => leadSessionIds.join('\0'),
    [leadSessionIds],
  );
  useWorkerProjectionOwners(leadSessionIds);
  const version = useWorkerProjectionVersion();

  return useMemo(() => {
    return new Map(
      leadSessionIds.map((leadSessionId) => [
        leadSessionId,
        new Set(
          getWorkerProjectionSnapshot(leadSessionId).workers.map((worker) => worker.sessionId),
        ),
      ]),
    );
  }, [leadSessionKey, version]);
}
