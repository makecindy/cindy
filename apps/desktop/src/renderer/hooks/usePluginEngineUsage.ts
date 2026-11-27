import { pluginEngineUsageClockKey } from '@cindy/maker-shared/plugin-engine-usage';
import type { GhostHarnessUsage } from '@cindy/plugin-protocol';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { readPluginEngineUsage } from '@/hooks/pluginEngineUsage';
import { formatCompactTimeUntilReset } from '@/lib/compactQuotaCountdown';
import { formatQuotaResetDuration } from '@/components/status/usageCardModel';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';

/**
 * Reads a plugin engine's account usage through the shared 1-minute reader and keeps a
 * visibility-aware local display clock so expiring windows and countdowns update without
 * triggering extra IPC requests.
 */
export function usePluginEngineUsage({
  engineKey,
  deviceId,
  enabled,
}: {
  engineKey: string | null | undefined;
  deviceId: string | null | undefined;
  enabled: boolean;
}): { usage: GhostHarnessUsage | null; now: number } {
  const { t } = useTranslation();
  const selfDeviceId = useOptionalAuthDeviceId();
  const rawDeviceId = deviceId ?? null;
  const blockedShare = isProviderShareAgentDeviceId(rawDeviceId);
  const normalizedDeviceId = rawDeviceId && rawDeviceId === selfDeviceId ? null : rawDeviceId;
  const activeKey = enabled && engineKey && !blockedShare
    ? `${normalizedDeviceId ?? ''}:${engineKey}`
    : null;

  const [reading, setReading] = useState<{ targetKey: string; usage: GhostHarnessUsage } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activeKey || !engineKey) return;
    const owner = getDataOwnerGeneration();
    let active = true;
    void readPluginEngineUsage(owner, normalizedDeviceId, engineKey).result.then((usage) => {
      if (!active || !isDataOwnerGenerationCurrent(owner)) return;
      setReading(usage ? { targetKey: activeKey, usage } : null);
      setNow(Date.now());
    });
    return () => {
      active = false;
    };
  }, [activeKey, engineKey, normalizedDeviceId]);

  const usage = activeKey && reading?.targetKey === activeKey ? reading.usage : null;
  const hasTimedWindow = !!usage?.windows?.some(
    (row) => typeof row.resetsAt === 'number' && row.resetsAt > now,
  );
  const clockSnapshot = useRef({ usage, now, t });
  clockSnapshot.current = { usage, now, t };

  useEffect(() => {
    if (!hasTimedWindow) return;
    const syncClock = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const { usage: currentUsage, now: prevNow, t: translate } = clockSnapshot.current;
      if (!currentUsage) return;
      const nextNow = Date.now();
      const formatReset = (
        resetsAtMs: number,
        currentNow: number,
        windowMinutes?: number | null,
      ) => {
        const resetsAtSec = resetsAtMs / 1000;
        return [
          formatQuotaResetDuration(resetsAtSec, currentNow, translate) ?? '',
          formatCompactTimeUntilReset(resetsAtSec, currentNow, translate, windowMinutes) ?? '',
        ].join(',');
      };
      if (
        pluginEngineUsageClockKey(currentUsage, prevNow, formatReset) !==
        pluginEngineUsageClockKey(currentUsage, nextNow, formatReset)
      ) {
        setNow(nextNow);
      }
    };
    const timer = window.setInterval(syncClock, 1000);
    const onVisibility = () => {
      if (!document.hidden) syncClock();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      window.clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [hasTimedWindow]);

  return { usage, now };
}
