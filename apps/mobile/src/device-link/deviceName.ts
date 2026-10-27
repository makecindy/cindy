import { deviceDisplayName as displayName, type DeviceNameSource } from '@cindy/maker-shared/device-list';
// The app initializes this singleton; plain name consumers must not load React bindings.
import i18n from 'i18next';
import enDevices from '@/i18n/locales/en/devices.json';

export const MAX_DEVICE_NAME_LENGTH = 64;

export function deviceDisplayName(deviceId: string, name?: string | null, devices: readonly DeviceNameSource[] = []): string {
  const unnamed = i18n.isInitialized
    ? i18n.t('devices.cloudCompanion.unknownDevice', { defaultValue: enDevices.cloudCompanion.unknownDevice })
    : enDevices.cloudCompanion.unknownDevice;
  return displayName(deviceId, name, unnamed, devices);
}
