/**
 * Main-process source of truth for the shared auxiliary-model chain.
 *
 * Only an explicit `models` override is persisted. An empty list (or a missing
 * file) means “automatic”, so restoring the default deletes the file rather
 * than writing a snapshot of the current built-in chain.
 */

import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import {
  AUXILIARY_MODEL_SETTINGS_DEFAULTS,
  normalizeAuxiliaryModelList,
  normalizeAuxiliaryModelRef,
  type AuxiliaryModelSettings,
  type AuxiliaryModelSettingsPatch,
} from '../../shared/auxiliaryModelSettings.js';
import { isUtilityModelProviderKind } from '../../shared/utilityModelProfiles.js';
import { resolveUtilityModelProviderKindAlias } from '../../shared/utilityModelProfiles.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('auxiliary-model-settings-store');
const VOICE_INPUT_MODELS_FILE = 'voice-input-models.json';

function settingsFilePath(): string {
  return ownerScopedUserDataPath('auxiliary-model-settings.json');
}

function ownerVoiceModelsPath(): string {
  return ownerScopedUserDataPath(VOICE_INPUT_MODELS_FILE);
}

function unscopedVoiceModelsPath(): string {
  return path.join(app.getPath('userData'), VOICE_INPUT_MODELS_FILE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectUniqueRefs(values: Array<string | null>): string[] {
  const models: string[] = [];
  for (const value of values) {
    if (!value || models.includes(value)) continue;
    models.push(value);
  }
  return models;
}

function refFromUnknown(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const catalogOrProfile = normalizeAuxiliaryModelRef(trimmed);
  if (catalogOrProfile) return catalogOrProfile;
  const alias = resolveUtilityModelProviderKindAlias(trimmed);
  return alias && isUtilityModelProviderKind(alias) ? alias : null;
}

function refsFromUnknownList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return collectUniqueRefs(value.map((entry) => refFromUnknown(entry)));
}

/**
 * A voice/utility file counts as customized only when the user (or an old
 * settings page) wrote a non-empty refiner/utility chain or a non-empty head.
 * Sparse empty strings are the product default, not an override.
 */
function legacyVoiceOverrideRefs(raw: Record<string, unknown> | null): string[] {
  if (!raw) return [];
  const head = refFromUnknown(
    raw.utilityModelProvider ?? raw.refinerProvider,
  );
  const chain = [
    ...refsFromUnknownList(raw.utilityModelProviderChain),
    ...refsFromUnknownList(raw.refinerProviderChain),
  ];
  const refs = collectUniqueRefs([head, ...chain]);
  const hasExplicitHead = typeof (raw.utilityModelProvider ?? raw.refinerProvider) === 'string'
    && String(raw.utilityModelProvider ?? raw.refinerProvider).trim().length > 0;
  const hasExplicitChain = chain.length > 0;
  if (!hasExplicitHead && !hasExplicitChain) return [];
  return refs;
}

function stripLegacyVoiceRefinerKeys(filePath: string): void {
  const raw = readJsonObject(filePath);
  if (!raw) return;
  const keys = [
    'refinerProvider',
    'refinerModel',
    'refinerProviderChain',
    'utilityModelProvider',
    'utilityModel',
    'utilityModelProviderChain',
  ] as const;
  let changed = false;
  for (const key of keys) {
    if (key in raw) {
      delete raw[key];
      changed = true;
    }
  }
  if (!changed) return;
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
  } catch (error) {
    log.warn('failed to strip legacy voice refiner keys', {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function rewriteAuxiliarySettingsFile(models: string[]): void {
  const file = settingsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (models.length === 0) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // Missing file is already the automatic state.
    }
    return;
  }
  fs.writeFileSync(file, `${JSON.stringify({ models }, null, 2)}\n`, 'utf-8');
}

/**
 * One-shot on-disk migration:
 * - old dual pins (title + recommendation) collapse into `models`, title first
 * - if auxiliary was never customized, a customized voice/utility chain moves in
 * - both customized → auxiliary wins; voice refiner keys are still stripped so
 *   we do not migrate twice
 */
export function migrateLegacyAuxiliaryModelSettings(): void {
  const file = settingsFilePath();
  const raw = readJsonObject(file);

  if (raw && Array.isArray(raw.models)) {
    stripLegacyVoiceRefinerKeys(ownerVoiceModelsPath());
    stripLegacyVoiceRefinerKeys(unscopedVoiceModelsPath());
    return;
  }

  const fromOldPins = raw
    ? collectUniqueRefs([
        normalizeAuxiliaryModelRef(raw.sessionTitleModel),
        normalizeAuxiliaryModelRef(raw.promptRecommendationModel),
      ])
    : [];

  if (fromOldPins.length > 0) {
    rewriteAuxiliarySettingsFile(fromOldPins);
    stripLegacyVoiceRefinerKeys(ownerVoiceModelsPath());
    stripLegacyVoiceRefinerKeys(unscopedVoiceModelsPath());
    log.info('migrated legacy auxiliary model pins', { count: fromOldPins.length });
    return;
  }

  const ownerVoice = legacyVoiceOverrideRefs(readJsonObject(ownerVoiceModelsPath()));
  const unscopedVoice = ownerVoice.length > 0
    ? []
    : legacyVoiceOverrideRefs(readJsonObject(unscopedVoiceModelsPath()));
  const fromVoice = (ownerVoice.length > 0 ? ownerVoice : unscopedVoice).slice(0, 3);

  if (fromVoice.length > 0) {
    rewriteAuxiliarySettingsFile(fromVoice);
    log.info('migrated legacy voice refiner chain into auxiliary models', {
      count: fromVoice.length,
    });
  } else if (raw && ('sessionTitleModel' in raw || 'promptRecommendationModel' in raw)) {
    rewriteAuxiliarySettingsFile([]);
  }

  stripLegacyVoiceRefinerKeys(ownerVoiceModelsPath());
  stripLegacyVoiceRefinerKeys(unscopedVoiceModelsPath());
}

function normalize(raw: unknown): AuxiliaryModelSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...AUXILIARY_MODEL_SETTINGS_DEFAULTS };
  }
  const input = raw as Record<string, unknown>;
  if (Array.isArray(input.models)) {
    return { models: normalizeAuxiliaryModelList(input.models) };
  }
  return {
    models: collectUniqueRefs([
      normalizeAuxiliaryModelRef(input.sessionTitleModel),
      normalizeAuxiliaryModelRef(input.promptRecommendationModel),
    ]),
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

function load(): OverrideSettingsState<AuxiliaryModelSettings> {
  migrateLegacyAuxiliaryModelSettings();
  store.invalidateIfChanged();
  return store.readState();
}

/** Hot-path read; an external config edit becomes visible without restarting. */
export function readAuxiliaryModelSettings(): AuxiliaryModelSettings {
  return load().value;
}

export function readAuxiliaryModelSettingsState(): OverrideSettingsState<AuxiliaryModelSettings> {
  return load();
}

export function isAuxiliaryModelCustomized(): boolean {
  return readAuxiliaryModelSettings().models.length > 0;
}

/** Owner-scoped atomic write; empty `models` removes the override file. */
export async function writeAuxiliaryModelSettingsPatch(
  patch: AuxiliaryModelSettingsPatch,
): Promise<void> {
  await store.writePatchAtomic(patch);
  log.info('auxiliary model settings written', {
    customizedKeys: store.readState().customizedKeys,
    models: store.read().models.length,
  });
}

export async function resetAuxiliaryModelSettings(): Promise<AuxiliaryModelSettings> {
  return store.resetAtomic();
}

export const __testing = {
  normalize,
  migrateLegacyAuxiliaryModelSettings,
  legacyVoiceOverrideRefs,
};
