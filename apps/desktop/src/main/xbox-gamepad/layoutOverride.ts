import {
  createXboxGamepadDefaultLayout,
  XBOX_GAMEPAD_BUTTON_IDS,
  XBOX_GAMEPAD_STICK_DIRECTIONS,
  XBOX_GAMEPAD_STICK_IDS,
  type XboxGamepadLayout,
  type XboxGamepadStickBinding,
} from '../../shared/xboxGamepad.js';

export function xboxGamepadLayoutOverrides(
  layout: XboxGamepadLayout,
  defaults: XboxGamepadLayout = createXboxGamepadDefaultLayout(),
): { version: 1; buttons: Record<string, unknown>; sticks: Record<string, unknown> } | null {
  const buttons: Record<string, unknown> = {};
  for (const id of XBOX_GAMEPAD_BUTTON_IDS) {
    if (JSON.stringify(layout.buttons[id]) !== JSON.stringify(defaults.buttons[id])) {
      buttons[id] = layout.buttons[id];
    }
  }
  const sticks: Record<string, unknown> = {};
  for (const id of XBOX_GAMEPAD_STICK_IDS) {
    const override = xboxGamepadStickOverrides(layout.sticks[id], defaults.sticks[id]);
    if (override) sticks[id] = override;
  }
  if (Object.keys(buttons).length === 0 && Object.keys(sticks).length === 0) return null;
  return { version: 1, buttons, sticks };
}

export function xboxGamepadStickOverrides(
  stick: XboxGamepadStickBinding,
  defaults: XboxGamepadStickBinding,
): { mode?: XboxGamepadStickBinding['mode']; directions?: Record<string, unknown> } | null {
  const directions: Record<string, unknown> = {};
  for (const direction of XBOX_GAMEPAD_STICK_DIRECTIONS) {
    if (JSON.stringify(stick.directions[direction]) !== JSON.stringify(defaults.directions[direction])) {
      directions[direction] = stick.directions[direction];
    }
  }
  const override: { mode?: XboxGamepadStickBinding['mode']; directions?: Record<string, unknown> } = {};
  if (stick.mode !== defaults.mode) override.mode = stick.mode;
  if (Object.keys(directions).length > 0) override.directions = directions;
  return Object.keys(override).length > 0 ? override : null;
}
