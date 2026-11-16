import { useRemoteProviderDisable } from '@/lib/remoteProviderDisable';
import { useMemo } from 'react';

import { sameRunLocationProvider, remoteInvocationModels, type ProviderView } from '@cindy/model-providers';

import { useControllableDevices } from '@/hooks/useControllableDevices';
import { useDevicesProviders } from '@/hooks/useDevicesProviders';
import {
  effectiveRunLocation,
  RUN_LOCATION_LOCAL,
  type RunLocationCandidate,
} from '@/lib/providerRunLocation';

/** 借用时「运行于」那台电脑上的这个供应商：模型清单、显示开关都以那台为准。 */
export interface BorrowedProviderCatalog {
  /** 那台电脑上的这个供应商，只保留开放给远程调用的模型。 */
  provider: ProviderView;
  /** 那台电脑的「模型显示 / 隐藏」快照；undefined = 旧版，不过滤。 */
  modelVisibilityOverrides?: Record<string, boolean>;
  /** 正在重新读取那台电脑的目录(上一次的清单仍在显示)。 */
  loading: boolean;
}

/**
 * 同账号其他电脑里提供这个供应商、且对本机开放的；`location` 是新任务实际运行的位置。`borrowed` 只在
 * 改由另一台运行时给出：整页按那台电脑显示；
 * `borrowedCatalog` 是那台电脑上这个供应商的快照，设置页的模型清单读它，不读本机目录。
 */
export function useProviderBorrow(provider: ProviderView | null | undefined) {
  const devices = useControllableDevices();
  const visibility = useRemoteProviderDisable();
  // 重新读取那台电脑的目录时保留上一次的显示，借用状态不会在刷新途中跳回「未连接」；
  // 断开与撤销仍立即清掉。
  const catalogs = useDevicesProviders(
    provider ? devices.map((device) => device.deviceId) : [],
    { retainDisplaySnapshot: true },
  );
  const candidates: RunLocationCandidate[] = !provider || provider.suspended || provider.agents.length === 0
    ? []
    : devices.flatMap((device) => {
      const offered = catalogs.get(device.deviceId)?.providers.find((entry) => entry.connected && !entry.suspended
        && entry.remoteInvocationEnabled === true && !(entry as { group?: unknown }).group
        && !visibility.isDisabled(device.deviceId, entry.id) && sameRunLocationProvider(provider, entry));
      return offered?.connected && !offered.suspended && offered.remoteInvocationEnabled === true
        ? [{ deviceId: device.deviceId, name: device.name, providerId: offered.id }]
        : [];
    });
  const location = provider
    ? effectiveRunLocation(provider as ProviderView & { runLocation?: string }, candidates)
    : RUN_LOCATION_LOCAL;
  const borrowed = location !== RUN_LOCATION_LOCAL
    ? candidates.find((candidate) => candidate.deviceId === location) ?? null
    : null;
  const borrowedSnapshot = borrowed ? catalogs.get(borrowed.deviceId) : undefined;
  const offered = borrowedSnapshot?.providers.find((entry) => entry.id === borrowed?.providerId);
  const overrides = borrowedSnapshot?.modelVisibilityOverrides;
  const loading = borrowedSnapshot?.loading ?? false;
  const borrowedCatalog = useMemo<BorrowedProviderCatalog | null>(
    () => offered
      ? {
          provider: remoteInvocationModels(offered),
          ...(overrides !== undefined ? { modelVisibilityOverrides: overrides } : {}),
          loading,
        }
      : null,
    [offered, overrides, loading],
  );
  return { candidates, location, borrowed, borrowedCatalog, routeProviderId: candidates.find(candidate => candidate.deviceId === location)?.providerId ?? provider?.id };
}
