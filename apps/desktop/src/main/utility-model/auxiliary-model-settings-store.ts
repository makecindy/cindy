/**
 * Main-process source of truth for short auxiliary text model choices.
 *
 * Only explicit overrides are persisted. A missing key means “automatic”, so
 * restoring the default removes that key (and removes the file when both keys
 * are automatic).
 */

import {
  AUXILIARY_MODEL_SETTINGS_DEFAULTS,
  normalizeAuxiliaryModelPin,
  type AuxiliaryModelSettings,
  type AuxiliaryModelSettingsKey,
  type AuxiliaryModelSettingsPatch,
} from '../../shared/auxiliaryModelSettings.js';
import { decodeCatalogModelPin, type CatalogModelPinRoute } from '../../shared/catalogModelPin.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('auxiliary-model-settings-store');

function settingsFilePath(): string {
  return ownerScopedUserDataPath('auxiliary-model-settings.json');
}

function normalize(raw: unknown): AuxiliaryModelSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...AUXILIARY_MODEL_SETTINGS_DEFAULTS };
  }
  const input = raw as Record<string, unknown>;
  return {
    sessionTitleModel: normalizeAuxiliaryModelPin(input.sessionTitleModel),
    promptRecommendationModel: normalizeAuxiliaryModelPin(input.promptRecommendationModel),
  };
}

const store = createOverrideSettingsFile<AuxiliaryModelSettings>({
  filePath: settingsFilePath,
  defaults: AUXILIARY_MODEL_SETTINGS_DEFAULTS,
  normalize,
  log,
  label: 'auxiliary model',
  scopeKey: activeOwnerScopeKey,
  maxBytes: 4 * 1024,
});

export interface AuxiliaryModelSelection extends CatalogModelPinRoute {
  pin: string;
}

/** Hot-path read; an external config edit becomes visible without restarting. */
export function readAuxiliaryModelSettings(): AuxiliaryModelSettings {
  store.invalidateIfChanged();
  return store.read();
}

export function readAuxiliaryModelSettingsState(): OverrideSettingsState<AuxiliaryModelSettings> {
  store.invalidateIfChanged();
  return store.readState();
}

/** A malformed disk value has already normalized to null and never reaches dispatch. */
export function readAuxiliaryModelSelection(
  key: AuxiliaryModelSettingsKey,
): AuxiliaryModelSelection | null {
  const pin = readAuxiliaryModelSettings()[key];
  if (!pin) return null;
  const route = decodeCatalogModelPin(pin);
  return route ? { ...route, pin } : null;
}

/** Owner-scoped atomic write; null removes the corresponding override key. */
export async function writeAuxiliaryModelSettingsPatch(
  patch: AuxiliaryModelSettingsPatch,
): Promise<void> {
  await store.writePatchAtomic(patch);
  log.info('auxiliary model settings written', {
    customizedKeys: store.readState().customizedKeys,
  });
}

export async function resetAuxiliaryModelSettings(): Promise<AuxiliaryModelSettings> {
  return store.resetAtomic();
}

export const __testing = { normalize };
