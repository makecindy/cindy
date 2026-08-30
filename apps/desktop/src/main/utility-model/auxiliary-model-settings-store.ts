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
import { encodeCatalogModelPin } from '../../shared/catalogModelPin.js';
import {
  getUtilityModelProfile,
  isUtilityModelProviderKind,
  resolveUtilityModelProviderKindAlias,
} from '../../shared/utilityModelProfiles.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('auxiliary-model-settings-store');
const VOICE_INPUT_MODELS_FILE = 'voice-input-models.json';
const AUXILIARY_MODEL_MIGRATION_FILE = 'auxiliary-model-settings-migration.json';

function settingsFilePath(): string {
  return ownerScopedUserDataPath('auxiliary-model-settings.json');
}

function ownerVoiceModelsPath(): string {
  return ownerScopedUserDataPath(VOICE_INPUT_MODELS_FILE);
}

function unscopedVoiceModelsPath(): string {
  return path.join(app.getPath('userData'), VOICE_INPUT_MODELS_FILE);
}

function migrationStatePath(): string {
  return ownerScopedUserDataPath(AUXILIARY_MODEL_MIGRATION_FILE);
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

function hasLegacyVoiceMigrationMarker(): boolean {
  return readJsonObject(migrationStatePath())?.legacyVoiceMigrationCompleted === true;
}

function markLegacyVoiceMigrationComplete(): void {
  const file = migrationStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ legacyVoiceMigrationCompleted: true }, null, 2)}\n`,
    'utf-8',
  );
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

function firstNonBlankString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function legacyVoiceHeadRef(raw: Record<string, unknown>): string | null {
  const providerValue = firstNonBlankString(raw.utilityModelProvider, raw.refinerProvider);
  const providerRef = refFromUnknown(providerValue);
  const model = firstNonBlankString(raw.utilityModel, raw.refinerModel);
  if (!providerRef && !model) return null;
  const effectiveProviderRef = providerRef ?? resolveUtilityModelProviderKindAlias('');
  if (!effectiveProviderRef) return null;
  if (!model) return effectiveProviderRef;

  // Preserve known model aliases as their exact profile key. This keeps the
  // old `litellm` + `qwen/qwen3.6-plus` form on the same credential transport
  // without freezing the provider's default model.
  const modelAlias = resolveUtilityModelProviderKindAlias(model);
  if (
    modelAlias
    && isUtilityModelProviderKind(effectiveProviderRef)
    && getUtilityModelProfile(effectiveProviderRef).transport === getUtilityModelProfile(modelAlias).transport
  ) {
    return modelAlias;
  }

  // Unknown model ids can still be represented as an exact catalog route. The
  // active catalog remains the final availability gate at dispatch time.
  if (isUtilityModelProviderKind(effectiveProviderRef)) {
    const profile = getUtilityModelProfile(effectiveProviderRef);
    return normalizeAuxiliaryModelRef(encodeCatalogModelPin({
      providerId: profile.transport === 'codex-responses' ? 'openai' : 'xd',
      agentKind: 'codex',
      model,
    }));
  }
  return effectiveProviderRef;
}

/**
 * A voice/utility file counts as customized only when the user (or an old
 * settings page) wrote a non-empty refiner/utility chain or a non-empty head.
 * Sparse empty strings are the product default, not an override.
 */
function legacyVoiceOverrideRefs(raw: Record<string, unknown> | null): string[] {
  if (!raw) return [];
  const head = legacyVoiceHeadRef(raw);
  const chain = refsFromUnknownList(raw.utilityModelProviderChain).length > 0
    ? refsFromUnknownList(raw.utilityModelProviderChain)
    : refsFromUnknownList(raw.refinerProviderChain);
  const refs = collectUniqueRefs([head, ...chain]);
  const hasExplicitHead = Boolean(
    firstNonBlankString(raw.utilityModelProvider, raw.refinerProvider)
      || firstNonBlankString(raw.utilityModel, raw.refinerModel),
  );
  const hasExplicitChain = chain.length > 0;
  if (!hasExplicitHead && !hasExplicitChain) return [];
  return refs;
}

type LegacyMigrationPlan = {
  models: string[];
  markVoiceMigrationComplete: boolean;
};

function readLegacyMigrationPlan(): LegacyMigrationPlan | null {
  const file = settingsFilePath();
  const raw = readJsonObject(file);

  if (raw && Array.isArray(raw.models)) return null;

  const fromOldPins = raw
    ? collectUniqueRefs([
        normalizeAuxiliaryModelRef(raw.sessionTitleModel),
        normalizeAuxiliaryModelRef(raw.promptRecommendationModel),
      ])
    : [];

  const legacyVoiceMigrationCompleted = hasLegacyVoiceMigrationMarker();
  const ownerVoice = legacyVoiceMigrationCompleted
    ? []
    : legacyVoiceOverrideRefs(readJsonObject(ownerVoiceModelsPath()));
  const unscopedVoice = ownerVoice.length > 0 || legacyVoiceMigrationCompleted
    ? []
    : legacyVoiceOverrideRefs(readJsonObject(unscopedVoiceModelsPath()));
  const fromVoice = (ownerVoice.length > 0 ? ownerVoice : unscopedVoice).slice(0, 3);

  if (fromOldPins.length > 0) {
    return {
      models: fromOldPins,
      markVoiceMigrationComplete: fromVoice.length > 0,
    };
  }

  if (legacyVoiceMigrationCompleted) return null;
  if (fromVoice.length > 0) {
    return { models: fromVoice, markVoiceMigrationComplete: true };
  }
  if (raw && ('sessionTitleModel' in raw || 'promptRecommendationModel' in raw)) {
    // Empty legacy pins should be cleared as well, otherwise the generic store
    // would keep reporting those obsolete keys as a customization.
    return { models: [], markVoiceMigrationComplete: false };
  }
  return null;
}

let pendingLegacyMigration: Promise<void> | null = null;

function scheduleLegacyMigration(): void {
  if (pendingLegacyMigration) return;
  pendingLegacyMigration = store.updateAtomic(() => {
    // Re-read under the same lock immediately before writing. A concurrent
    // settings save wins; stale migration data is never written over it.
    const currentPlan = readLegacyMigrationPlan();
    if (!currentPlan) return {};
    if (currentPlan.markVoiceMigrationComplete) markLegacyVoiceMigrationComplete();
    return { models: currentPlan.models };
  }).then(() => undefined).catch((error) => {
    log.warn('legacy auxiliary model migration failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }).finally(() => {
    pendingLegacyMigration = null;
  });
}

/**
 * One-shot on-disk migration:
 * - old dual pins (title + recommendation) collapse into `models`, title first
 * - if auxiliary was never customized, a customized voice/utility chain moves in
 * - both customized → auxiliary wins; the legacy voice file is left untouched
 *   so older clients and passive instances can continue reading it
 */
export function migrateLegacyAuxiliaryModelSettings(): void {
  if (readLegacyMigrationPlan()) scheduleLegacyMigration();
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
  mergeOverrides: ({ patch, next, defaults, overrides }) => {
    const nextOverrides = { ...overrides };
    for (const key of Object.keys(patch) as Array<keyof AuxiliaryModelSettings>) {
      const normalizedValue = next[key];
      if (JSON.stringify(normalizedValue) === JSON.stringify(defaults[key])) {
        delete nextOverrides[String(key)];
      } else {
        nextOverrides[String(key)] = normalizedValue;
      }
    }
    if ('models' in patch) {
      delete nextOverrides.sessionTitleModel;
      delete nextOverrides.promptRecommendationModel;
    }
    return nextOverrides;
  },
});

function load(): OverrideSettingsState<AuxiliaryModelSettings> {
  store.invalidateIfChanged();
  const state = store.readState();
  const plan = readLegacyMigrationPlan();
  if (!plan) return state;
  scheduleLegacyMigration();
  return {
    ...state,
    value: { models: plan.models },
    isCustomized: plan.models.length > 0,
    customizedKeys: plan.models.length > 0 ? ['models'] : [],
  };
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
  if (patch.models?.length === 0) {
    await store.updateAtomic(() => {
      // A reset can race with the first legacy migration. Seal the legacy
      // voice import while holding the same lock so it cannot resurrect the
      // chain after this empty patch removes the new override.
      const legacyVoice = hasLegacyVoiceMigrationMarker()
        || legacyVoiceOverrideRefs(readJsonObject(ownerVoiceModelsPath())).length > 0
        || legacyVoiceOverrideRefs(readJsonObject(unscopedVoiceModelsPath())).length > 0;
      if (legacyVoice) markLegacyVoiceMigrationComplete();
      return patch;
    });
  } else {
    await store.writePatchAtomic(patch);
  }
  log.info('auxiliary model settings written', {
    customizedKeys: store.readState().customizedKeys,
    models: store.read().models.length,
  });
}

export async function resetAuxiliaryModelSettings(): Promise<AuxiliaryModelSettings> {
  return store.updateAtomic(() => {
    // Keep this decision under the same settings lock as reset. Otherwise a
    // pending migration could reacquire the lock after reset and resurrect the
    // legacy voice chain that the user just cleared.
    const legacyVoice = hasLegacyVoiceMigrationMarker()
      || legacyVoiceOverrideRefs(readJsonObject(ownerVoiceModelsPath())).length > 0
      || legacyVoiceOverrideRefs(readJsonObject(unscopedVoiceModelsPath())).length > 0;
    if (legacyVoice) markLegacyVoiceMigrationComplete();
    return { models: [] };
  });
}

export const __testing = {
  normalize,
  migrateLegacyAuxiliaryModelSettings,
  legacyVoiceOverrideRefs,
  flushLegacyMigration: async () => {
    await pendingLegacyMigration;
  },
};
