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
  const [order, setOrder] = useState<{ scope: string | null; ids: string[] } | null>(null);
  const rememberedIds = order?.scope === scope ? order.ids : stored;
  const knownIds = new Set(rememberedIds);
  const newcomers = workers.filter((worker) => !knownIds.has(worker.workerId));
  const ids = newcomers.length
    ? [...rememberedIds, ...newcomers.map((worker) => worker.workerId)]
    : rememberedIds;
  // Snapshots arrive newest-first. Remember first-seen IDs in the existing view
  // state so later arrivals cannot displace earlier newcomers. Keep absent IDs
  // through transient empty projections; only explicit sorting writes storage.
  if (order?.scope !== scope || newcomers.length) setOrder({ scope, ids });
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
    setOrder({ scope, ids: next });
    if (!scope) return;
    try {
      localStorage.setItem(scope, JSON.stringify(next));
    } catch {
      // Display remains usable when browser storage is unavailable.
    }
  };
  return { workers: ordered, reorder, scope };
}
