import { useEffect, useMemo, useState } from 'react';

import type { Session } from '@/lib/ccAgent.types';
import { isOrcaLeadSession } from '@/lib/orcaSessionIdentity';
import { orcaWorkflowsFor, subscribeOrcaWorkerChanged } from '@/lib/makerTransport';

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
  const [map, setMap] = useState<Map<string, ReadonlySet<string>>>(() => new Map());

  useEffect(() => {
    if (leadSessionIds.length === 0) {
      setMap(new Map());
      return;
    }

    let cancelled = false;
    const refresh = () => void Promise.all(
      leadSessionIds.map(async (leadSessionId) => {
        const workers = await orcaWorkflowsFor(leadSessionId)
          .listWorkersByLead(leadSessionId)
          .catch(() => []);
        return [leadSessionId, workers.map((worker) => worker.sessionId)] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setMap(new Map(entries.map(([leadSessionId, workerIds]) => [
        leadSessionId,
        new Set(workerIds),
      ])));
    });
    refresh();

    // 每个 lead 按来源路由订阅 worker 变更:本机 lead → 本地 onOrcaWorkerChanged;
    // 远程(device-link)lead → 被控端 maker:orca:worker-changed 经隧道转发。
    // subscribeOrcaWorkerChanged 内部已按 leadSessionId 过滤,命中即重拉该批映射。
    const unsubscribes = leadSessionIds.map((leadSessionId) =>
      subscribeOrcaWorkerChanged(leadSessionId, refresh),
    );

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [leadSessionKey]);

  return map;
}
