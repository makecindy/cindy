import {
  createXboxGamepadDefaultLayout,
  XBOX_GAMEPAD_BUTTON_IDS,
  XBOX_GAMEPAD_STICK_IDS,
  type XboxGamepadLayout,
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
    if (JSON.stringify(layout.sticks[id]) !== JSON.stringify(defaults.sticks[id])) {
      sticks[id] = layout.sticks[id];
    }
  }
  if (Object.keys(buttons).length === 0 && Object.keys(sticks).length === 0) return null;
  return { version: 1, buttons, sticks };
}
