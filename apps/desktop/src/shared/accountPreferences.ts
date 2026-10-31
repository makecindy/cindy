import { parseAccountPreferenceValues, type AccountPreferenceKey, type AccountPreferenceValue, type AccountPreferenceValues } from '@cindy/device-link';
import { isDataOwnerPushStamp, type DataOwnerPushStamp } from './dataOwnerPush.js';

export interface AccountPreferencesSnapshot extends DataOwnerPushStamp {
  /** Only explicit overrides and reset tombstones; missing keys follow this device's defaults. */
  values: AccountPreferenceValues;
  /** The unscoped legacy preferences can be claimed by one data owner only. */
  legacyImportAllowed: boolean;
}

export interface AccountPreferenceWriteRequest extends DataOwnerPushStamp {
  key: AccountPreferenceKey;
  value: AccountPreferenceValue;
}

export interface AccountPreferencesLegacyImportRequest extends DataOwnerPushStamp {
  values: AccountPreferenceValues;
}

export function isAccountPreferencesSnapshot(value: unknown): value is AccountPreferencesSnapshot {
  if (!isDataOwnerPushStamp(value)) return false;
  const source = value as unknown as Record<string, unknown>;
  return typeof source.legacyImportAllowed === 'boolean'
    && parseAccountPreferenceValues(source.values) !== null;
}
