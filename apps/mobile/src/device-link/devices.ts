import {
  buildDeviceListPresentation as buildDeviceListPresentationShared,
  toDeviceListItem as toDeviceListItemShared,
  toDeviceListItems as toDeviceListItemsShared,
  type DeviceListDeviceLike,
  type DeviceListVisibility,
} from '@cindy/maker-shared/device-list';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';

export * from '@cindy/maker-shared/device-list';

export interface DirectoryDisplayBudget {
  wallUntil?: number;
  monoUntil?: number;
  expired: boolean;
}

/**
 * Sticky observation for a directory display budget. A missing deadline (old
 * endpoint) keeps the legacy lifecycle; once either absolute clock reaches its
 * deadline the source stays expired until a fresh read replaces the budget.
 */
export function observeDirectoryBudgetExpiry(
  budget: DirectoryDisplayBudget,
  wallNow = Date.now(),
  monoNow = performance.now(),
): boolean {
  if (budget.expired) return true;
  if (budget.wallUntil === undefined || budget.monoUntil === undefined) return false;
  if (wallNow < budget.wallUntil && monoNow < budget.monoUntil) return false;
  budget.expired = true;
  return true;
}

/** Defer render-time retirement until after render. */
export function scheduleDirectoryBudgetRetirement(
  budget: DirectoryDisplayBudget & { token: number; owner: number; retired: boolean; retireScheduled: boolean },
  retire: (token: number, owner: number) => void,
): void {
  if (!budget.expired || budget.retired || budget.retireScheduled) return;
  const { token, owner } = budget;
  budget.retireScheduled = true;
  queueMicrotask(() => {
    if (budget.token !== token || budget.owner !== owner) return;
    budget.retireScheduled = false;
    if (budget.expired) retire(token, owner);
  });
}

export function toDeviceListItems<TDevice extends DeviceListDeviceLike>(
  devices: readonly TDevice[],
  now = Date.now(),
  revokedDevices: ReadonlySet<string> = new Set(),
) {
  return toDeviceListItemsShared(devices, now, revokedDevices, mobilePresentationLocalizer);
}

export function toDeviceListItem<TDevice extends DeviceListDeviceLike>(
  device: TDevice,
  now = Date.now(),
  revokedDevices: ReadonlySet<string> = new Set(),
) {
  return toDeviceListItemShared(device, now, revokedDevices, mobilePresentationLocalizer);
}

export function buildDeviceListPresentation(
  visibility: Pick<DeviceListVisibility, 'availableCount' | 'hiddenUnavailableCount' | 'unavailableCount'>,
  showUnavailable: boolean,
) {
  return buildDeviceListPresentationShared(visibility, showUnavailable, mobilePresentationLocalizer);
}
