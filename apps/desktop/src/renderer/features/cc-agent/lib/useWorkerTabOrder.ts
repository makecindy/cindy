import { useMemo, useState } from 'react';
import { getDataOwnerGeneration, isDataOwnerIdCurrent } from '@/contexts/dataOwnerGeneration';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import type { WorkerInfo } from '../hooks/useWorkers';

/** Display preference only: never reorder the Orca projection or execution queue. */
export function useWorkerTabOrder(workers: WorkerInfo[], leadSessionId?: string) {
  const owner = getDataOwnerGeneration();
  const hostId = getStickySessionDeviceId(leadSessionId) ?? 'local';
  const scope = leadSessionId
    ? `orca-worker-tab-order-v1:${JSON.stringify([owner.dataOwnerId, hostId, leadSessionId])}`
    : null;
  const stored = useMemo((): string[] => {
    if (!scope) return [];
    try {
      const value: unknown = JSON.parse(localStorage.getItem(scope) ?? 'null');
      return Array.isArray(value) && value.every((id) => typeof id === 'string')
        ? [...new Set(value)]
        : [];
    } catch {
      return [];
    }
  }, [scope]);
  const [manual, setManual] = useState<{ scope: string | null; ids: string[] } | null>(null);
  const ids = manual?.scope === scope ? manual.ids : stored;
  const byId = new Map(workers.map((worker) => [worker.workerId, worker]));
  const ordered = ids.flatMap((id) => {
    const worker = byId.get(id);
    if (!worker) return [];
    byId.delete(id);
    return [worker];
  });
  ordered.push(...byId.values());

  const reorder = (nextIds: string[]) => {
    // A gesture started under another account must not write into either namespace.
    if (!isDataOwnerIdCurrent(owner)) return;
    const currentIds = new Set(workers.map((worker) => worker.workerId));
    const next = [...new Set(nextIds)].filter((id) => currentIds.has(id));
    const retained = new Set(next);
    next.push(...workers.filter((worker) => !retained.has(worker.workerId)).map((worker) => worker.workerId));
    if (next.every((id, index) => id === ordered[index]?.workerId)) return;
    setManual({ scope, ids: next });
    if (!scope) return;
    try {
      localStorage.setItem(scope, JSON.stringify(next));
    } catch {
      // Display remains usable when browser storage is unavailable.
    }
  };
  return { workers: ordered, reorder, scope };
}
