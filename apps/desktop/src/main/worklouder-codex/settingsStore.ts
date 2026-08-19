/** Main-process persistence for Work Louder Codex Micro device preferences. */

import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';

import {
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  WORKLOUDER_CODEX_ANALOG_DIRECTIONS,
  WORKLOUDER_CODEX_COMMAND_SLOTS,
  WORKLOUDER_CODEX_DEFAULT_LAYOUT,
  createWorkLouderCodexDefaultSettings,
  normalizeWorkLouderCodexAgentSource,
  isWorkLouderCodexAutoDim,
  isWorkLouderCodexCommandId,
  isWorkLouderCodexEncoderMode,
  isWorkLouderCodexKeycapId,
  type WorkLouderCodexAction,
  type WorkLouderCodexKeyAssignment,
  type WorkLouderCodexLayout,
  type WorkLouderCodexSettings,
  type WorkLouderCodexSettingsPatch,
} from '../../shared/workLouderCodex.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('worklouder-codex-settings-store');
const MAX_SETTINGS_BYTES = 64 * 1024;

function settingsFilePath(): string {
  return ownerScopedUserDataPath('worklouder-codex-settings.json');
}

function normalizeAction(raw: unknown): WorkLouderCodexAction | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
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
    keycapId: isWorkLouderCodexKeycapId(value.keycapId) ? value.keycapId : fallback.keycapId,
    action: value.action === null ? null : normalizeAction(value.action),
  };
}

function normalizeLayout(raw: unknown): WorkLouderCodexLayout {
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawSlots = asRecord(value.slots);
  const rawAnalog = asRecord(value.analogStick);
  const rawEncoder = asRecord(value.encoder);
  const slots = Object.fromEntries(
    WORKLOUDER_CODEX_COMMAND_SLOTS.map((slot) => [
      slot,
      normalizeKeyAssignment(rawSlots[slot], WORKLOUDER_CODEX_DEFAULT_LAYOUT.slots[slot]),
    ]),
  ) as WorkLouderCodexLayout['slots'];
  const analogStick = Object.fromEntries(
    WORKLOUDER_CODEX_ANALOG_DIRECTIONS.map((direction) => [
      direction,
      rawAnalog[direction] === null
        ? null
        : (normalizeAction(rawAnalog[direction]) ??
          WORKLOUDER_CODEX_DEFAULT_LAYOUT.analogStick[direction]),
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
      : WORKLOUDER_CODEX_DEFAULT_LAYOUT.encoderMode,
    separateMicrophoneKeys:
      typeof value.separateMicrophoneKeys === 'boolean'
        ? value.separateMicrophoneKeys
        : WORKLOUDER_CODEX_DEFAULT_LAYOUT.separateMicrophoneKeys,
  };
}

function normalize(raw: unknown): WorkLouderCodexSettings {
  const defaults = createWorkLouderCodexDefaultSettings();
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
    layout: normalizeLayout(value.layout),
  };
}

const store = createOverrideSettingsFile<WorkLouderCodexSettings>({
  filePath: settingsFilePath,
  defaults: createWorkLouderCodexDefaultSettings(),
  normalize,
  log,
  label: 'worklouder-codex',
  scopeKey: activeOwnerScopeKey,
  maxBytes: MAX_SETTINGS_BYTES,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
});

export function readWorkLouderCodexSettings(): WorkLouderCodexSettings {
  return store.read();
}

export function writeWorkLouderCodexSettingsPatch(
  patch: WorkLouderCodexSettingsPatch,
): WorkLouderCodexSettings {
  store.writePatch(patch);
  log.info('Work Louder Codex settings written', { keys: Object.keys(patch) });
  return store.read();
}

export function resetWorkLouderCodexSettings(): WorkLouderCodexSettings {
  const keepEnabled = store.read().deviceEnabled;
  const settings = store.reset();
  log.info('Work Louder Codex settings reset');
  // Restore-defaults resets layout and lighting, but never turns the keyboard off
  // after the user has already chosen to use it in this instance.
  if (keepEnabled) return writeWorkLouderCodexSettingsPatch({ deviceEnabled: true });
  return settings;
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

export const __testing = { normalize, normalizeAction, normalizeLayout };
