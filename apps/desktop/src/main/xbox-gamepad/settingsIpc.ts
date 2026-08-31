import { isInputDeviceCommandId } from '../../shared/inputDevices.js';
import {
  isGamepadFamily,
  isXboxGamepadStickMode,
  XBOX_GAMEPAD_BUTTON_IDS,
  XBOX_GAMEPAD_STICK_DIRECTIONS,
  XBOX_GAMEPAD_STICK_IDS,
  type GamepadAccessoriesState,
  type GamepadFamily,
  type XboxGamepadBinding,
  type XboxGamepadLayout,
  type XboxGamepadSettings,
  type XboxGamepadSettingsPatch,
  type XboxGamepadStickBinding,
} from '../../shared/xboxGamepad.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const SETTING_KEYS = ['deviceEnabled', 'layout'] as const;

export interface XboxGamepadSettingsIpcDeps {
  assertTrustedSender(event: unknown): void;
  getState(): GamepadAccessoriesState;
  writeSettings(family: GamepadFamily, patch: XboxGamepadSettingsPatch): XboxGamepadSettings;
  resetSettings(family: GamepadFamily): XboxGamepadSettings;
  applySettings(family: GamepadFamily, settings: XboxGamepadSettings): void;
  probeDevice(): void;
  setLayoutPreviewActive(active: boolean, family: GamepadFamily | null, event: unknown): void;
}

export function createXboxGamepadSettingsIpc(deps: XboxGamepadSettingsIpcDeps) {
  return {
    get(event: unknown): GamepadAccessoriesState {
      deps.assertTrustedSender(event);
      return deps.getState();
    },
    set(event: unknown, family: unknown, patch: unknown): GamepadAccessoriesState {
      deps.assertTrustedSender(event);
      const next = deps.writeSettings(parseFamily(family), parseSettingsPatch(patch));
      deps.applySettings(parseFamily(family), next);
      return deps.getState();
    },
    reset(event: unknown, family: unknown): GamepadAccessoriesState {
      deps.assertTrustedSender(event);
      const resolved = parseFamily(family);
      const next = deps.resetSettings(resolved);
      deps.applySettings(resolved, next);
      return deps.getState();
    },
    probe(event: unknown): GamepadAccessoriesState {
      deps.assertTrustedSender(event);
      deps.probeDevice();
      return deps.getState();
    },
    setLayoutPreviewActive(event: unknown, value: unknown): void {
      deps.assertTrustedSender(event);
      if (typeof value === 'boolean') {
        deps.setLayoutPreviewActive(value, value ? 'xbox' : null, event);
        return;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throwIpcError('INVALID_PARAMS', 'layout preview flag must be a boolean or object');
      }
      const record = value as { active?: unknown; family?: unknown };
      if (typeof record.active !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'layout preview flag must be a boolean');
      }
      deps.setLayoutPreviewActive(
        record.active,
        record.active ? parseFamily(record.family) : null,
        event,
      );
    },
  };
}

function parseFamily(value: unknown): GamepadFamily {
  if (!isGamepadFamily(value)) throwIpcError('INVALID_PARAMS', 'gamepad family is invalid');
  return value;
}

function parseSettingsPatch(value: unknown): XboxGamepadSettingsPatch {
  const record = requireRecord(value, 'Xbox gamepad settings patch required');
  rejectUnknownKeys(record, SETTING_KEYS, 'Xbox gamepad setting');
  if (Object.keys(record).length === 0) {
    throwIpcError('INVALID_PARAMS', 'Xbox gamepad settings patch cannot be empty');
  }
  const patch: XboxGamepadSettingsPatch = {};
  if ('deviceEnabled' in record) {
    if (typeof record.deviceEnabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'deviceEnabled must be a boolean');
    }
    patch.deviceEnabled = record.deviceEnabled;
  }
  if ('layout' in record) patch.layout = parseLayout(record.layout);
  return patch;
}

function parseLayout(value: unknown): XboxGamepadLayout {
  const record = requireRecord(value, 'layout must be an object');
  rejectUnknownKeys(record, ['version', 'buttons', 'sticks'], 'layout field');
  if (record.version !== 1) throwIpcError('INVALID_PARAMS', 'layout version must be 1');
  const buttonsRecord = requireRecord(record.buttons, 'layout buttons must be an object');
  rejectUnknownKeys(buttonsRecord, XBOX_GAMEPAD_BUTTON_IDS, 'layout button');
  const buttons = Object.fromEntries(
    XBOX_GAMEPAD_BUTTON_IDS.map((id) => [id, parseBinding(buttonsRecord[id] ?? null)]),
  ) as XboxGamepadLayout['buttons'];

  const sticksRecord = requireRecord(record.sticks, 'layout sticks must be an object');
  rejectUnknownKeys(sticksRecord, XBOX_GAMEPAD_STICK_IDS, 'layout stick');
  const sticks = Object.fromEntries(
    XBOX_GAMEPAD_STICK_IDS.map((id) => [id, parseStick(sticksRecord[id], id)]),
  ) as XboxGamepadLayout['sticks'];

  return { version: 1, buttons, sticks };
}

function parseStick(value: unknown, id: string): XboxGamepadStickBinding {
  const record = requireRecord(value, `${id} stick assignment is required`);
  rejectUnknownKeys(record, ['mode', 'directions'], `${id} stick field`);
  if (!isXboxGamepadStickMode(record.mode)) {
    throwIpcError('INVALID_PARAMS', `${id} stick mode is invalid`);
  }
  const directionsRecord = requireRecord(record.directions, `${id} stick directions must be an object`);
  rejectUnknownKeys(directionsRecord, XBOX_GAMEPAD_STICK_DIRECTIONS, `${id} stick direction`);
  const directions = Object.fromEntries(
    XBOX_GAMEPAD_STICK_DIRECTIONS.map((direction) => {
      const binding = parseBinding(directionsRecord[direction] ?? null);
      if (binding?.type === 'voice') {
        throwIpcError('INVALID_PARAMS', `${id} stick directions cannot use voice`);
      }
      return [direction, binding];
    }),
  ) as XboxGamepadStickBinding['directions'];
  return { mode: record.mode, directions };
}

function parseBinding(value: unknown): XboxGamepadBinding | null {
  if (value === null) return null;
  const record = requireRecord(value, 'gamepad binding must be an object');
  if (record.type === 'command') {
    rejectUnknownKeys(record, ['type', 'commandId'], 'command binding field');
    if (!isInputDeviceCommandId(record.commandId)) {
      throwIpcError('INVALID_PARAMS', 'command binding is invalid');
    }
    return { type: 'command', commandId: record.commandId };
  }
  if (record.type === 'skill') {
    rejectUnknownKeys(record, ['type', 'skillId', 'name'], 'skill binding field');
    return {
      type: 'skill',
      skillId: requireBoundedString(record.skillId, 1_024, 'skillId'),
      name: requireBoundedString(record.name, 256, 'skill name'),
    };
  }
  if (record.type === 'voice') {
    rejectUnknownKeys(record, ['type'], 'voice binding field');
    return { type: 'voice' };
  }
  throwIpcError('INVALID_PARAMS', 'gamepad binding type is invalid');
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', message);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throwIpcError('INVALID_PARAMS', `unknown ${label}: ${unknown}`);
}

function requireBoundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throwIpcError('INVALID_PARAMS', `${label} is invalid`);
  }
  return value;
}
