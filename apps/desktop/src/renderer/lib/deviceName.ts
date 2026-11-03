import { deviceDisplayName as displayName, type DeviceNameSource } from '@cindy/maker-shared/device-list';
// The renderer initializes this singleton; display helpers do not initialize React bindings.
import i18n from 'i18next';
import enCommon from '@/i18n/locales/en/common.json';

export function deviceDisplayName(deviceId: string, name?: string | null, devices: readonly DeviceNameSource[] = []): string {
  const unnamed = i18n.isInitialized
    ? i18n.t('bots.cloud.unknownDevice', { defaultValue: enCommon.bots.cloud.unknownDevice })
    : enCommon.bots.cloud.unknownDevice;
  return displayName(deviceId, name, unnamed, devices);
}
