import {
  buildDeviceListPresentation as buildDeviceListPresentationShared,
  toDeviceListItem as toDeviceListItemShared,
  toDeviceListItems as toDeviceListItemsShared,
  type DeviceListDeviceLike,
  type DeviceListVisibility,
} from '@cindy/maker-shared/device-list';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';

export * from '@cindy/maker-shared/device-list';

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
