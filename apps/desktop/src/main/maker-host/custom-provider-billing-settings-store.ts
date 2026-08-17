/**
 * custom-provider-billing-settings-store: whether custom (user-defined) providers
 * should display SDK self-reported cost as a money amount.
 *
 * File: <userData>/custom-provider-billing-settings.json
 *   { "showSdkCostForCustomProviders": false }
 *
 * Default off: for custom providers the SDK self-reported cost is only a client-side
 * estimate and cannot be verified against the user's own provider bill. Cindy hides that
 * SDK amount by default while preserving token usage and independently sourced price
 * estimates. Users may opt into showing the SDK amount, with the explicit caveat that its
 * pricing is not controllable and may not match their real bill.
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('custom-provider-billing-settings-store');

export interface CustomProviderBillingSettings {
  showSdkCostForCustomProviders: boolean;
}

const DEFAULTS: CustomProviderBillingSettings = {
  showSdkCostForCustomProviders: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'custom-provider-billing-settings.json');
}

function normalize(raw: unknown): CustomProviderBillingSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    showSdkCostForCustomProviders:
      typeof r.showSdkCostForCustomProviders === 'boolean'
        ? r.showSdkCostForCustomProviders
        : DEFAULTS.showSdkCostForCustomProviders,
  };
}

const store = createOverrideSettingsFile<CustomProviderBillingSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'custom provider billing',
});

export function readCustomProviderBillingSettings(): CustomProviderBillingSettings {
  return store.read();
}

export function readCustomProviderBillingSettingsState(): OverrideSettingsState<CustomProviderBillingSettings> {
  return store.readState();
}

export function writeCustomProviderShowSdkCostEnabled(
  showSdkCostForCustomProviders: boolean,
): OverrideSettingsState<CustomProviderBillingSettings> {
  store.writePatch({ showSdkCostForCustomProviders });
  log.info('custom provider billing setting written', { showSdkCostForCustomProviders });
  return store.readState();
}

export function resetCustomProviderBillingSettings(): CustomProviderBillingSettings {
  return store.reset();
}

export const __testing = { normalize };
