/** Main-process persistence for Work Louder keyboard preferences, one file per model. */

import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';

import {
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  WORKLOUDER_CODEX_ANALOG_DIRECTIONS,
  WORKLOUDER_CODEX_COMMAND_SLOTS,
  WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS,
  WORKLOUDER_MODELS,
  createWorkLouderCodexDefaultSettings,
  isWorkLouderCreatorProgrammableKey,
  normalizeWorkLouderCodexAgentSource,
  workLouderTaskKeysForLayout,
  workLouderLayoutMerges,
  workLouderMicrophoneKeysSeparate,
  isWorkLouderCodexAutoDim,
  isWorkLouderCodexDoubleKeycap,
  isWorkLouderCodexMicrophoneKeycap,
  isWorkLouderCodexCommandId,
  isWorkLouderCodexEncoderMode,
  isWorkLouderCodexKeycapId,
  isWorkLouderCodexBlankKeycap,
  canonicalizeWorkLouderCodexKeycapId,
  type WorkLouderCodexAction,
  type WorkLouderCodexKeyAssignment,
  type WorkLouderCodexLayout,
  type WorkLouderCodexSettings,
  type WorkLouderCodexSettingsPatch,
  type WorkLouderModel,
} from '../../shared/workLouderCodex.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('worklouder-codex-settings-store');
const MAX_SETTINGS_BYTES = 64 * 1024;

function settingsFileName(model: WorkLouderModel): string {
  return model === 'creator-micro-2'
    ? 'worklouder-creator-micro-2-settings.json'
    : 'worklouder-codex-settings.json';
}

function normalizeAction(raw: unknown): WorkLouderCodexAction | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.type === 'voice') {
    return { type: 'voice' };
  }
  if (value.type === 'command' && isWorkLouderCodexCommandId(value.commandId)) {
    return { type: 'command', commandId: value.commandId };
  }
  if (value.type === 'task' && isBoundedString(value.sessionId, 512)) {
    return { type: 'task', sessionId: value.sessionId };
  }
  if (value.type === 'keycap' && isWorkLouderCodexKeycapId(value.keycapId)) {
    return { type: 'keycap', keycapId: value.keycapId };
  }
  if (
    value.type === 'skill' &&
    isBoundedString(value.skillId, 1_024) &&
    isBoundedString(value.name, 256)
  ) {
    return { type: 'skill', skillId: value.skillId, name: value.name };
  }
  if (value.type === 'composer-text' && isBoundedString(value.text, 2_000)) {
    return { type: 'composer-text', text: value.text };
  }
  if (value.type === 'external-url' && isSafeExternalUrl(value.url)) {
    return { type: 'external-url', url: value.url };
  }
  return null;
}

function normalizeKeyAssignment(
  raw: unknown,
  fallback: WorkLouderCodexKeyAssignment,
): WorkLouderCodexKeyAssignment {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback };
  const value = raw as Record<string, unknown>;
  return {
    keycapId: isWorkLouderCodexKeycapId(value.keycapId)
      ? canonicalizeWorkLouderCodexKeycapId(value.keycapId)
      : fallback.keycapId,
    action: value.action === null ? null : normalizeAction(value.action),
  };
}

function normalizeLayout(raw: unknown, model: WorkLouderModel): WorkLouderCodexLayout {
  const defaults = createWorkLouderCodexDefaultSettings(model).layout;
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawSlots = asRecord(value.slots);
  const rawAnalog = asRecord(value.analogStick);
  const rawEncoder = asRecord(value.encoder);
  const separateMicrophoneKeys =
    typeof value.separateMicrophoneKeys === 'boolean'
      ? value.separateMicrophoneKeys
      : defaults.separateMicrophoneKeys;
  let slots = Object.fromEntries(
    WORKLOUDER_CODEX_COMMAND_SLOTS.map((slot) => [
      slot,
      normalizeKeyAssignment(rawSlots[slot], defaults.slots[slot]),
    ]),
  ) as WorkLouderCodexLayout['slots'];
  const blank: WorkLouderCodexKeyAssignment = { keycapId: 'EMPT1', action: null };
  for (const key of WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS) {
    if (key.startsWith('AG') && rawSlots[key]) {
      slots = {
        ...slots,
        [key]: normalizeKeyAssignment(rawSlots[key], blank),
      };
    }
  }
  if (
    model === 'creator-micro-2' &&
    isCreatorFactoryBlankSlots(slots) &&
    value.taskKeys === undefined &&
    value.merges === undefined
  ) {
    slots = defaults.slots;
  }
  const merges = workLouderLayoutMerges({
    merges: value.merges,
    separateMicrophoneKeys,
  });
  const microphoneMerged = merges.some(
    (merge) => merge.origin === 'ACT10' && merge.cover === 'ACT11',
  );
  if (microphoneMerged) {
    const alias = slots.ACT10_ACT11;
    const origin = slots.ACT10;
    // Old files kept the 2U cap on ACT10_ACT11 while ACT10 was still a 1U blank.
    // Origin is source of truth after that; copying the alias over a user-chosen
    // MIC (or any other 1U cap) made the picker flash and revert.
    const unmigratedOrigin =
      isWorkLouderCodexBlankKeycap(origin.keycapId) &&
      !isWorkLouderCodexDoubleKeycap(origin.keycapId);
    const aliasHasMergedCap =
      isWorkLouderCodexDoubleKeycap(alias.keycapId) ||
      isWorkLouderCodexMicrophoneKeycap(alias.keycapId);
    // Old files stored the 2U cap on ACT10_ACT11 and often left ACT10 as MIC.
    // New files have `merges` and keep origin as source of truth.
    const legacyMergedAlias = value.merges === undefined && aliasHasMergedCap;
    if (aliasHasMergedCap && (legacyMergedAlias || unmigratedOrigin)) {
      slots = { ...slots, ACT10: { ...alias } };
    } else {
      slots = { ...slots, ACT10_ACT11: { ...origin } };
    }
  }
  const analogStick = Object.fromEntries(
    WORKLOUDER_CODEX_ANALOG_DIRECTIONS.map((direction) => [
      direction,
      rawAnalog[direction] === null
        ? null
        : (normalizeAction(rawAnalog[direction]) ?? defaults.analogStick[direction]),
    ]),
  ) as WorkLouderCodexLayout['analogStick'];
  const encoder = Object.fromEntries(
    (['left', 'right', 'click', 'longPress'] as const).map((action) => [
      action,
      rawEncoder[action] === null ? null : normalizeAction(rawEncoder[action]),
    ]),
  ) as WorkLouderCodexLayout['encoder'];
  return {
    version: 1,
    slots,
    analogStick,
    encoder,
    encoderMode: isWorkLouderCodexEncoderMode(value.encoderMode)
      ? value.encoderMode
      : defaults.encoderMode,
    separateMicrophoneKeys: workLouderMicrophoneKeysSeparate(merges),
    merges,
    taskKeys: workLouderTaskKeysForLayout({
      taskKeys: value.taskKeys,
      merges,
      separateMicrophoneKeys: workLouderMicrophoneKeysSeparate(merges),
    }),
  };
}

/** First Creator layouts stored empty EMPT actions; those keys would never fire. */
function isCreatorFactoryBlankSlots(slots: WorkLouderCodexLayout['slots']): boolean {
  return WORKLOUDER_CODEX_COMMAND_SLOTS.every(
    (slot) => isWorkLouderCodexBlankKeycap(slots[slot].keycapId) && slots[slot].action === null,
  );
}

function normalize(raw: unknown, model: WorkLouderModel = 'codex-micro'): WorkLouderCodexSettings {
  const defaults = createWorkLouderCodexDefaultSettings(model);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const value = raw as Record<string, unknown>;
  const brightness = value.lightingBrightness;
  const rawCustomAgentKeys = Array.isArray(value.customAgentKeys) ? value.customAgentKeys : null;
  const customAgentKeys = rawCustomAgentKeys
    ? Array.from({ length: WORKLOUDER_CODEX_AGENT_SLOT_COUNT }, (_, index) =>
        rawCustomAgentKeys[index] === null ? null : normalizeAction(rawCustomAgentKeys[index]),
      )
    : defaults.customAgentKeys;
  return {
    lightingBrightness:
      typeof brightness === 'number' && Number.isFinite(brightness)
        ? Math.max(0, Math.min(100, Math.round(brightness)))
        : defaults.lightingBrightness,
    lightingAutoDim: isWorkLouderCodexAutoDim(value.lightingAutoDim)
      ? value.lightingAutoDim
      : defaults.lightingAutoDim,
    deviceEnabled:
      typeof value.deviceEnabled === 'boolean' ? value.deviceEnabled : defaults.deviceEnabled,
    agentSource: normalizeWorkLouderCodexAgentSource(value.agentSource),
    customAgentKeys,
    singleTapAgentKeys:
      typeof value.singleTapAgentKeys === 'boolean'
        ? value.singleTapAgentKeys
        : defaults.singleTapAgentKeys,
    layout: normalizeLayout(value.layout, model),
  };
}

function createStore(model: WorkLouderModel) {
  return createOverrideSettingsFile<WorkLouderCodexSettings>({
    filePath: () => ownerScopedUserDataPath(settingsFileName(model)),
    defaults: () => createWorkLouderCodexDefaultSettings(model),
    normalize: (raw) => normalize(raw, model),
    log,
    label: model === 'creator-micro-2' ? 'worklouder-creator-micro-2' : 'worklouder-codex',
    scopeKey: activeOwnerScopeKey,
    maxBytes: MAX_SETTINGS_BYTES,
    preserveUnreadableFile: true,
    logLoadedValue: false,
    logReadErrorDetails: false,
  });
}

const stores = Object.fromEntries(WORKLOUDER_MODELS.map((model) => [model, createStore(model)])) as Record<
  WorkLouderModel,
  ReturnType<typeof createStore>
>;

export function readWorkLouderCodexSettings(
  model: WorkLouderModel = 'codex-micro',
): WorkLouderCodexSettings {
  const store = stores[model];
  store.invalidateIfChanged();
  return store.read();
}

export function writeWorkLouderCodexSettingsPatch(
  model: WorkLouderModel,
  patch: WorkLouderCodexSettingsPatch,
): WorkLouderCodexSettings {
  const store = stores[model];
  store.writePatch(patch);
  log.info('Work Louder settings written', { model, keys: Object.keys(patch) });
  return store.read();
}

export function resetWorkLouderCodexSettings(
  model: WorkLouderModel = 'codex-micro',
): WorkLouderCodexSettings {
  const store = stores[model];
  const keepEnabled = store.read().deviceEnabled;
  const settings = store.reset();
  log.info('Work Louder settings reset', { model });
  // Restore-defaults resets layout and lighting, but never turns the keyboard off
  // after the user has already chosen to use it in this instance.
  if (keepEnabled) return writeWorkLouderCodexSettingsPatch(model, { deviceEnabled: true });
  return settings;
}

export function readAllWorkLouderSettings(): Record<WorkLouderModel, WorkLouderCodexSettings> {
  return Object.fromEntries(
    WORKLOUDER_MODELS.map((model) => [model, readWorkLouderCodexSettings(model)]),
  ) as Record<WorkLouderModel, WorkLouderCodexSettings>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isSafeExternalUrl(value: unknown): value is string {
  if (!isBoundedString(value, 2_048)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export const __testing = {
  normalize,
  normalizeAction,
  normalizeLayout: (raw: unknown) => normalizeLayout(raw, 'codex-micro'),
};
