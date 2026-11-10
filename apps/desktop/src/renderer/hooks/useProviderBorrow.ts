import type { ProviderView } from '@cindy/model-providers';

import { useControllableDevices } from '@/hooks/useControllableDevices';
import { useDevicesProviders } from '@/hooks/useDevicesProviders';
import {
  effectiveRunLocation,
  RUN_LOCATION_LOCAL,
  type RunLocationCandidate,
} from '@/lib/providerRunLocation';

/**
 * 同账号其他电脑里提供这个供应商、且对本机开放的；`location` 是新任务实际运行的位置。`borrowed` 只在
 * 这台电脑用不了这个供应商、改由另一台运行时给出：整页按「能用」显示，不提本机的登录状态。
 */
export function useProviderBorrow(provider: ProviderView | null | undefined) {
  const devices = useControllableDevices();
  const catalogs = useDevicesProviders(provider ? devices.map((device) => device.deviceId) : []);
  const candidates: RunLocationCandidate[] = !provider || provider.suspended || provider.agents.length === 0
    ? []
    : devices.flatMap((device) => {
      const offered = catalogs.get(device.deviceId)?.providers.find((entry) => entry.id === provider.id);
      return offered?.connected && !offered.suspended && offered.remoteInvocationEnabled === true
        ? [{ deviceId: device.deviceId, name: device.name }]
        : [];
    });
  const location = provider
    ? effectiveRunLocation(provider as ProviderView & { runLocation?: string }, candidates)
    : RUN_LOCATION_LOCAL;
  const localUsable = !!provider?.connected && !provider.suspended;
  const borrowed = !localUsable && location !== RUN_LOCATION_LOCAL
    ? candidates.find((candidate) => candidate.deviceId === location) ?? null
    : null;
  return { candidates, location, borrowed };
}
