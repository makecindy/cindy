import { ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import {
  cloneXboxGamepadBinding,
  createXboxGamepadDefaultLayout,
  createXboxGamepadDefaultSettings,
  isXboxGamepadBinding,
  isXboxGamepadStickMode,
  XBOX_GAMEPAD_BUTTON_IDS,
  XBOX_GAMEPAD_STICK_DIRECTIONS,
  XBOX_GAMEPAD_STICK_IDS,
  type XboxGamepadLayout,
  type XboxGamepadSettings,
  type XboxGamepadSettingsPatch,
  type XboxGamepadStickBinding,
} from '../../shared/xboxGamepad.js';
import { xboxGamepadLayoutOverrides } from './layoutOverride.js';

const log = desktopMakerLogger.child('xbox-gamepad-settings-store');

function settingsFilePath(): string {
  return ownerScopedUserDataPath('xbox-gamepad-settings.json');
}

function normalizeStick(raw: unknown, fallback: XboxGamepadStickBinding): XboxGamepadStickBinding {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const value = raw as Record<string, unknown>;
  const directionsRaw =
    value.directions && typeof value.directions === 'object' && !Array.isArray(value.directions)
      ? (value.directions as Record<string, unknown>)
      : {};
  return {
    mode: isXboxGamepadStickMode(value.mode) ? value.mode : fallback.mode,
    directions: Object.fromEntries(
      XBOX_GAMEPAD_STICK_DIRECTIONS.map((direction) => {
        if (!Object.prototype.hasOwnProperty.call(directionsRaw, direction)) {
          return [direction, cloneXboxGamepadBinding(fallback.directions[direction])];
        }
        const rawDirection = directionsRaw[direction];
        if (rawDirection === null) return [direction, null];
        const binding = cloneXboxGamepadBinding(
          isXboxGamepadBinding(rawDirection) ? rawDirection : fallback.directions[direction],
        );
        return [direction, binding?.type === 'voice' ? null : binding];
      }),
    ) as XboxGamepadStickBinding['directions'],
  };
}

function normalizeLayout(raw: unknown): XboxGamepadLayout {
  const defaults = createXboxGamepadDefaultLayout();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const value = raw as Record<string, unknown>;
  const buttonsRaw =
    value.buttons && typeof value.buttons === 'object' && !Array.isArray(value.buttons)
      ? (value.buttons as Record<string, unknown>)
      : {};
  const sticksRaw =
    value.sticks && typeof value.sticks === 'object' && !Array.isArray(value.sticks)
      ? (value.sticks as Record<string, unknown>)
      : {};
  return {
    version: 1,
    buttons: Object.fromEntries(
      XBOX_GAMEPAD_BUTTON_IDS.map((id) => [
        id,
        cloneXboxGamepadBinding(
          buttonsRaw[id] === null
            ? null
            : isXboxGamepadBinding(buttonsRaw[id])
              ? buttonsRaw[id]
              : defaults.buttons[id],
        ),
      ]),
    ) as XboxGamepadLayout['buttons'],
    sticks: Object.fromEntries(
      XBOX_GAMEPAD_STICK_IDS.map((id) => [id, normalizeStick(sticksRaw[id], defaults.sticks[id])]),
    ) as XboxGamepadLayout['sticks'],
  };
}

function normalizeSettings(raw: unknown): XboxGamepadSettings {
  const defaults = createXboxGamepadDefaultSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const value = raw as Record<string, unknown>;
  return {
    deviceEnabled: typeof value.deviceEnabled === 'boolean' ? value.deviceEnabled : defaults.deviceEnabled,
    layout: normalizeLayout(value.layout),
  };
}

const store = createOverrideSettingsFile<XboxGamepadSettings>({
  filePath: settingsFilePath,
  defaults: createXboxGamepadDefaultSettings,
  normalize: normalizeSettings,
  mergeOverrides: ({ patch, next, defaults, overrides }) => {
    const nextOverrides = { ...overrides };
    if ('deviceEnabled' in patch) {
      if (next.deviceEnabled === defaults.deviceEnabled) delete nextOverrides.deviceEnabled;
      else nextOverrides.deviceEnabled = next.deviceEnabled;
    }
    if ('layout' in patch) {
      const layout = xboxGamepadLayoutOverrides(next.layout, defaults.layout);
      if (layout) nextOverrides.layout = layout;
      else delete nextOverrides.layout;
    }
    return nextOverrides;
  },
  log,
  label: 'Xbox gamepad',
  maxBytes: 64 * 1024,
});

export function readXboxGamepadSettings(): XboxGamepadSettings {
  store.invalidateIfChanged();
  return store.read();
}

export function writeXboxGamepadSettingsPatch(patch: XboxGamepadSettingsPatch): XboxGamepadSettings {
  store.writePatch(patch);
  log.info('Xbox gamepad settings written', { keys: Object.keys(patch) });
  return store.read();
}

export function resetXboxGamepadSettings(): XboxGamepadSettings {
  const keepEnabled = store.read().deviceEnabled;
  store.reset();
  log.info('Xbox gamepad settings reset');
  if (keepEnabled) return writeXboxGamepadSettingsPatch({ deviceEnabled: true });
  return store.read();
}
