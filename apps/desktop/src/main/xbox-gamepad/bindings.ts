import type { InputDeviceRendererAction } from '../../shared/inputDevices.js';
import {
  normalizeJoystickIntensity,
  WORKLOUDER_JOYSTICK_ACTIVATION_DISTANCE,
} from '../../shared/workLouderCodexScroll.js';
import {
  XBOX_GAMEPAD_BUTTON_IDS,
  XBOX_GAMEPAD_STICK_IDS,
  type XboxGamepadBinding,
  type XboxGamepadButtonId,
  type XboxGamepadLayout,
  type XboxGamepadStickDirection,
  type XboxGamepadStickId,
} from '../../shared/xboxGamepad.js';

export type XboxGamepadButtons = Record<XboxGamepadButtonId, boolean>;

export interface XboxGamepadAxes {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}

export interface XboxGamepadTriggers {
  lt: number;
  rt: number;
}

export interface XboxGamepadFrame {
  buttons: XboxGamepadButtons;
  axes: XboxGamepadAxes;
  triggers: XboxGamepadTriggers;
}

const EMPTY_BUTTONS = Object.fromEntries(XBOX_GAMEPAD_BUTTON_IDS.map((id) => [id, false])) as XboxGamepadButtons;

export const XBOX_GAMEPAD_EMPTY_FRAME: XboxGamepadFrame = {
  buttons: { ...EMPTY_BUTTONS },
  axes: { lx: 0, ly: 0, rx: 0, ry: 0 },
  triggers: { lt: 0, rt: 0 },
};

const TRIGGER_PRESS = 0.55;
const TRIGGER_RELEASE = 0.4;

export function digitalTriggerPressed(previous: boolean, value: number): boolean {
  if (!Number.isFinite(value)) return previous;
  if (previous) return value > TRIGGER_RELEASE;
  return value >= TRIGGER_PRESS;
}

/**
 * Turns one gamepad snapshot into Cindy hardware actions using the saved layout.
 *
 * The first frame after listen starts never fires button edges, so enabling
 * the adapter mid-hold cannot submit or start voice by accident.
 */
export function reduceXboxGamepadFrame(
  previous: XboxGamepadFrame | null,
  next: XboxGamepadFrame,
  layout: XboxGamepadLayout,
): InputDeviceRendererAction[] {
  const actions: InputDeviceRendererAction[] = [];
  if (previous) {
    for (const id of XBOX_GAMEPAD_BUTTON_IDS) {
      const binding = layout.buttons[id];
      if (!binding || binding.type === 'voice') continue;
      if (pressed(previous.buttons[id], next.buttons[id])) {
        const action = actionFromBinding(binding);
        if (action) actions.push(action);
      }
    }
    const wasVoice = voiceHeld(previous, layout);
    const isVoice = voiceHeld(next, layout);
    if (wasVoice !== isVoice) {
      actions.push({ type: 'voice', phase: isVoice ? 'press' : 'release' });
    }
    for (const stick of XBOX_GAMEPAD_STICK_IDS) {
      if (layout.sticks[stick].mode !== 'custom') continue;
      const previousHat = hatFromStick(stickAxes(previous, stick));
      const nextHat = hatFromStick(stickAxes(next, stick));
      if (!nextHat || nextHat === previousHat) continue;
      const binding = layout.sticks[stick].directions[nextHat];
      if (!binding || binding.type === 'voice') continue;
      const action = actionFromBinding(binding);
      if (action) actions.push(action);
    }
  }

  const previousScroll = previous ? combinedScroll(previous, layout) : null;
  const nextScroll = combinedScroll(next, layout);
  if (!sameScroll(previousScroll, nextScroll)) {
    actions.push(nextScroll ?? { type: 'scroll-stop' });
  }
  return actions;
}

export function xboxGamepadHoldReleases(
  frame: XboxGamepadFrame | null,
  layout: XboxGamepadLayout,
): InputDeviceRendererAction[] {
  if (!frame) return [];
  const actions: InputDeviceRendererAction[] = [];
  if (voiceHeld(frame, layout)) actions.push({ type: 'voice', phase: 'release' });
  if (combinedScroll(frame, layout)) actions.push({ type: 'scroll-stop' });
  return actions;
}

export function xboxGamepadPreviewFromFrame(frame: XboxGamepadFrame) {
  return {
    buttons: { ...frame.buttons },
    sticks: {
      left: { x: frame.axes.lx, y: frame.axes.ly },
      right: { x: frame.axes.rx, y: frame.axes.ry },
    },
    triggers: { ...frame.triggers },
  };
}

function pressed(wasDown: boolean, isDown: boolean): boolean {
  return !wasDown && isDown;
}

function voiceHeld(frame: XboxGamepadFrame, layout: XboxGamepadLayout): boolean {
  return XBOX_GAMEPAD_BUTTON_IDS.some(
    (id) => layout.buttons[id]?.type === 'voice' && frame.buttons[id],
  );
}

function actionFromBinding(binding: XboxGamepadBinding): InputDeviceRendererAction | null {
  if (binding.type === 'command') return { type: 'command', commandId: binding.commandId };
  if (binding.type === 'skill') {
    return { type: 'skill', skillId: binding.skillId, name: binding.name };
  }
  return null;
}

function stickAxes(
  frame: XboxGamepadFrame,
  stick: XboxGamepadStickId,
): { x: number; y: number } {
  return stick === 'left'
    ? { x: frame.axes.lx, y: frame.axes.ly }
    : { x: frame.axes.rx, y: frame.axes.ry };
}

function hatFromStick(axes: { x: number; y: number }): XboxGamepadStickDirection | null {
  const distance = Math.hypot(axes.x, axes.y);
  if (distance < WORKLOUDER_JOYSTICK_ACTIVATION_DISTANCE) return null;
  if (Math.abs(axes.y) >= Math.abs(axes.x)) return axes.y >= 0 ? 'up' : 'down';
  return axes.x >= 0 ? 'right' : 'left';
}

function combinedScroll(
  frame: XboxGamepadFrame,
  layout: XboxGamepadLayout,
): Extract<InputDeviceRendererAction, { type: 'scroll' }> | null {
  let best: Extract<InputDeviceRendererAction, { type: 'scroll' }> | null = null;
  for (const stick of XBOX_GAMEPAD_STICK_IDS) {
    if (layout.sticks[stick].mode !== 'conversation-scroll') continue;
    const next = scrollFromStick(stickAxes(frame, stick));
    if (next && (!best || next.intensity > best.intensity)) best = next;
  }
  return best;
}

function scrollFromStick(
  axes: { x: number; y: number },
): Extract<InputDeviceRendererAction, { type: 'scroll' }> | null {
  const distance = Math.abs(axes.y);
  if (distance < WORKLOUDER_JOYSTICK_ACTIVATION_DISTANCE) return null;
  const intensity = normalizeJoystickIntensity(distance);
  if (intensity <= 0) return null;
  return {
    type: 'scroll',
    direction: axes.y >= 0 ? 'up' : 'down',
    intensity,
  };
}

function sameScroll(
  left: Extract<InputDeviceRendererAction, { type: 'scroll' }> | null,
  right: Extract<InputDeviceRendererAction, { type: 'scroll' }> | null,
): boolean {
  if (left === null && right === null) return true;
  if (!left || !right) return false;
  return left.direction === right.direction && Math.abs(left.intensity - right.intensity) < 0.02;
}
