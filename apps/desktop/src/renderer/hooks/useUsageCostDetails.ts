import { useEffect, useState } from 'react';
import { normalizeUsageCostRows, type UsageCostRow } from '@cindy/maker-shared/usage-cost-details';
import { estimatedSessionValueFor } from '@/lib/makerTransport';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';

/** Details are read only while visible, from the task's owning computer. */
export function useUsageCostDetails(
  sessionId: string | undefined,
  visible: boolean,
  clientId?: string,
) {
  const [snapshot, setSnapshot] = useState<{ key: string; rows: UsageCostRow[] | null } | null>(
    null,
  );
  const key = `${sessionId ?? ''}/${clientId ?? ''}`;
  useEffect(() => {
    if (!sessionId || !visible) return;
    let cancelled = false,
      request = 0;
    const owner = getDataOwnerGeneration();
    const deviceId = getStickySessionDeviceId(sessionId);
    const read = async () => {
      const version = ++request;
      try {
        const result = await estimatedSessionValueFor(sessionId, {
          includeBreakdown: true,
          ...(clientId ? { clientId } : {}),
        });
        if (!cancelled && version === request && isDataOwnerGenerationCurrent(owner))
          setSnapshot({
            key,
            rows: Array.isArray(result.costBreakdown)
              ? normalizeUsageCostRows(result.costBreakdown)
              : null,
          });
      } catch {
        if (!cancelled && version === request && isDataOwnerGenerationCurrent(owner))
          setSnapshot({ key, rows: null });
      }
    };
    const unsubscribe = window.electronAPI.onUsageMessageTurnCost?.((payload, ownerStamp) => {
      if (!deviceId && payload.sessionId === sessionId && isDataOwnerPushCurrent(ownerStamp))
        void read();
    });
    const unsubscribeRemote = deviceId
      ? window.electronAPI.deviceLink?.onRemotePush?.((push, stamp) => {
          if (
            push.deviceId !== deviceId ||
            push.channel !== 'usage:message-turn-cost' ||
            !isDeviceLinkRemotePushCurrent(push, stamp)
          )
            return;
          if ((push.payload as { sessionId?: string } | null)?.sessionId === sessionId) void read();
        })
      : undefined;
    void read();
    return () => {
      cancelled = true;
      unsubscribe?.();
      unsubscribeRemote?.();
    };
  }, [sessionId, clientId, visible, key]);
  return snapshot?.key === key ? snapshot.rows : undefined;
}
