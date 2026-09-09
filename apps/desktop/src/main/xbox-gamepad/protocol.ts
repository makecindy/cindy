import { isGamepadFamily, XBOX_GAMEPAD_BUTTON_IDS, type GamepadFamily } from '../../shared/xboxGamepad.js';
import {
  digitalTriggerPressed,
  XBOX_GAMEPAD_EMPTY_FRAME,
  type XboxGamepadAxes,
  type XboxGamepadButtons,
  type XboxGamepadFrame,
  type XboxGamepadTriggers,
} from './bindings.js';

export type XboxGamepadHostMessage =
  | {
      kind: 'presence';
      present: boolean;
      name?: string;
      category?: string;
      family?: GamepadFamily;
      transport?: 'usb' | 'bluetooth' | 'unknown';
      batteryPercentage?: number;
      batteryState?: 'unknown' | 'discharging' | 'charging' | 'full';
    }
  | {
      kind: 'frame';
      family?: GamepadFamily;
      buttons: XboxGamepadButtons;
      axes: XboxGamepadAxes;
      triggers: XboxGamepadTriggers;
    }
  | { kind: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  /**
   * Synthesized by the host when the helper cannot be built or spawned. It is
   * deliberately absent from isXboxGamepadHostMessage: only main may report it,
   * never a line off the helper's stdout.
   */
  | { kind: 'host-error'; message: string };

export function isXboxGamepadHostMessage(value: unknown): value is XboxGamepadHostMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as { kind?: unknown };
  if (message.kind === 'presence') {
    const record = message as {
      present?: unknown;
      name?: unknown;
      category?: unknown;
      family?: unknown;
      transport?: unknown;
      batteryPercentage?: unknown;
      batteryState?: unknown;
    };
    if (typeof record.present !== 'boolean') return false;
    if (record.name !== undefined && typeof record.name !== 'string') return false;
    if (record.category !== undefined && typeof record.category !== 'string') return false;
    if (record.family !== undefined && !isGamepadFamily(record.family)) return false;
    if (
      record.transport !== undefined &&
      record.transport !== 'usb' &&
      record.transport !== 'bluetooth' &&
      record.transport !== 'unknown'
    ) {
      return false;
    }
    if (
      record.batteryPercentage !== undefined &&
      (typeof record.batteryPercentage !== 'number' ||
        !Number.isFinite(record.batteryPercentage) ||
        record.batteryPercentage < 0 ||
        record.batteryPercentage > 100)
    ) {
      return false;
    }
    if (
      record.batteryState !== undefined &&
      record.batteryState !== 'unknown' &&
      record.batteryState !== 'discharging' &&
      record.batteryState !== 'charging' &&
      record.batteryState !== 'full'
    ) {
      return false;
    }
    return true;
  }
  if (message.kind === 'log') {
    const level = (message as { level?: unknown }).level;
    const text = (message as { message?: unknown }).message;
    return (
      (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') &&
      typeof text === 'string'
    );
  }
  if (message.kind !== 'frame') return false;
  const frame = message as { family?: unknown };
  if (frame.family !== undefined && !isGamepadFamily(frame.family)) return false;
  return parseXboxGamepadFrame(message) !== null;
}

export function parseXboxGamepadFrame(value: unknown): XboxGamepadFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as {
    buttons?: unknown;
    axes?: unknown;
    ltAnalog?: unknown;
    rtAnalog?: unknown;
    triggers?: unknown;
  };
  const buttons = parseButtons(record.buttons);
  const axes = parseAxes(record.axes);
  if (!buttons || !axes) return null;
  const triggers = parseTriggers(record.triggers, record.ltAnalog, record.rtAnalog);
  if (triggers.ltAnalogPresent) buttons.lt = digitalTriggerPressed(buttons.lt, triggers.values.lt);
  if (triggers.rtAnalogPresent) buttons.rt = digitalTriggerPressed(buttons.rt, triggers.values.rt);
  return { buttons, axes, triggers: triggers.values };
}

function parseButtons(value: unknown): XboxGamepadButtons | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const buttons = { ...XBOX_GAMEPAD_EMPTY_FRAME.buttons };
  for (const id of XBOX_GAMEPAD_BUTTON_IDS) {
    if (record[id] === undefined) continue;
    if (typeof record[id] !== 'boolean') return null;
    buttons[id] = record[id];
  }
  return buttons;
}

function parseAxes(value: unknown): XboxGamepadAxes | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const lx = optionalUnit(record.lx);
  const ly = optionalUnit(record.ly);
  const rx = optionalUnit(record.rx);
  const ry = optionalUnit(record.ry);
  if (
    (record.lx !== undefined && lx === null) ||
    (record.ly !== undefined && ly === null) ||
    (record.rx !== undefined && rx === null) ||
    (record.ry !== undefined && ry === null)
  ) {
    return null;
  }
  return { lx: lx ?? 0, ly: ly ?? 0, rx: rx ?? 0, ry: ry ?? 0 };
}

function parseTriggers(
  value: unknown,
  ltAnalog: unknown,
  rtAnalog: unknown,
): {
  values: XboxGamepadTriggers;
  ltAnalogPresent: boolean;
  rtAnalogPresent: boolean;
} {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const lt = optionalUnit(record.lt) ?? optionalUnit(ltAnalog);
  const rt = optionalUnit(record.rt) ?? optionalUnit(rtAnalog);
  return {
    values: { lt: clamp01(lt ?? 0), rt: clamp01(rt ?? 0) },
    ltAnalogPresent: lt !== null,
    rtAnalogPresent: rt !== null,
  };
}

function optionalUnit(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(-1, Math.min(1, value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
