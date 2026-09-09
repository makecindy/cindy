import { describe, expect, it } from 'vitest';

import {
  cloneXboxGamepadLayout,
  createXboxGamepadDefaultLayout,
} from '../../../shared/xboxGamepad.js';
import {
  digitalTriggerPressed,
  reduceXboxGamepadFrame,
  xboxGamepadHoldReleases,
  XBOX_GAMEPAD_EMPTY_FRAME,
  type XboxGamepadFrame,
} from '../bindings.js';

function press(...ids: Array<keyof XboxGamepadFrame['buttons']>): XboxGamepadFrame {
  const buttons = { ...XBOX_GAMEPAD_EMPTY_FRAME.buttons };
  for (const id of ids) buttons[id] = true;
  return { ...XBOX_GAMEPAD_EMPTY_FRAME, buttons };
}

function axes(partial: Partial<XboxGamepadFrame['axes']>): XboxGamepadFrame {
  return {
    ...XBOX_GAMEPAD_EMPTY_FRAME,
    axes: { ...XBOX_GAMEPAD_EMPTY_FRAME.axes, ...partial },
  };
}

describe('reduceXboxGamepadFrame', () => {
  const layout = createXboxGamepadDefaultLayout();

  it('does not fire button edges on the first frame', () => {
    expect(
      reduceXboxGamepadFrame(null, { ...press('a', 'lt'), axes: { ...XBOX_GAMEPAD_EMPTY_FRAME.axes, ry: 1 } }, layout),
    ).toEqual([{ type: 'scroll', direction: 'up', intensity: expect.any(Number) }]);
  });

  it('maps face and bumper edges to Cindy commands', () => {
    const idle = XBOX_GAMEPAD_EMPTY_FRAME;
    expect(reduceXboxGamepadFrame(idle, press('a'), layout)).toEqual([
      { type: 'command', commandId: 'composer.submit' },
    ]);
    expect(reduceXboxGamepadFrame(idle, press('y'), layout)).toEqual([
      { type: 'command', commandId: 'newTask' },
    ]);
    expect(reduceXboxGamepadFrame(idle, press('lb'), layout)).toEqual([
      { type: 'command', commandId: 'composer.decreaseReasoningEffort' },
    ]);
    expect(reduceXboxGamepadFrame(idle, press('rb'), layout)).toEqual([
      { type: 'command', commandId: 'composer.increaseReasoningEffort' },
    ]);
    expect(reduceXboxGamepadFrame(idle, press('menu'), layout)).toEqual([
      { type: 'command', commandId: 'settings' },
    ]);
  });

  it('starts and stops voice from the bound trigger', () => {
    expect(reduceXboxGamepadFrame(XBOX_GAMEPAD_EMPTY_FRAME, press('lt'), layout)).toEqual([
      { type: 'voice', phase: 'press' },
    ]);
    expect(reduceXboxGamepadFrame(press('lt'), XBOX_GAMEPAD_EMPTY_FRAME, layout)).toEqual([
      { type: 'voice', phase: 'release' },
    ]);
  });

  it('scrolls with a conversation-scroll stick and stops at center', () => {
    const started = reduceXboxGamepadFrame(XBOX_GAMEPAD_EMPTY_FRAME, axes({ ry: 1 }), layout);
    expect(started[0]).toMatchObject({ type: 'scroll', direction: 'up' });
    expect(reduceXboxGamepadFrame(axes({ ry: 1 }), XBOX_GAMEPAD_EMPTY_FRAME, layout)).toEqual([
      { type: 'scroll-stop' },
    ]);
  });

  it('ignores horizontal-only conversation-scroll input', () => {
    expect(reduceXboxGamepadFrame(XBOX_GAMEPAD_EMPTY_FRAME, axes({ rx: 1 }), layout)).toEqual([]);
  });

  it('uses remapped button bindings', () => {
    const remapped = cloneXboxGamepadLayout(layout);
    remapped.buttons.a = { type: 'command', commandId: 'newTask' };
    remapped.buttons.b = { type: 'command', commandId: 'composer.submit' };
    remapped.buttons.lt = { type: 'command', commandId: 'settings' };
    expect(reduceXboxGamepadFrame(XBOX_GAMEPAD_EMPTY_FRAME, press('a'), remapped)).toEqual([
      { type: 'command', commandId: 'newTask' },
    ]);
    expect(reduceXboxGamepadFrame(XBOX_GAMEPAD_EMPTY_FRAME, press('b'), remapped)).toEqual([
      { type: 'command', commandId: 'composer.submit' },
    ]);
    expect(reduceXboxGamepadFrame(XBOX_GAMEPAD_EMPTY_FRAME, press('lt'), remapped)).toEqual([
      { type: 'command', commandId: 'settings' },
    ]);
  });

  it('fires custom stick directions on entering a quadrant', () => {
    const remapped = cloneXboxGamepadLayout(layout);
    remapped.sticks.right.mode = 'custom';
    remapped.sticks.right.directions.up = { type: 'command', commandId: 'toggleSidebar' };
    expect(reduceXboxGamepadFrame(XBOX_GAMEPAD_EMPTY_FRAME, axes({ ry: 1 }), remapped)).toEqual([
      { type: 'command', commandId: 'toggleSidebar' },
    ]);
    expect(reduceXboxGamepadFrame(axes({ ry: 1 }), axes({ ry: 1 }), remapped)).toEqual([]);
  });

  it('does not fire unmapped buttons', () => {
    const remapped = cloneXboxGamepadLayout(layout);
    remapped.buttons.x = null;
    expect(reduceXboxGamepadFrame(XBOX_GAMEPAD_EMPTY_FRAME, press('x'), remapped)).toEqual([]);
  });

  it('selects tasks from the left stick and opens sidebars from its sides', () => {
    expect(reduceXboxGamepadFrame(XBOX_GAMEPAD_EMPTY_FRAME, axes({ ly: 1 }), layout)).toEqual([
      { type: 'command', commandId: 'session.selectPrevious' },
    ]);
    expect(reduceXboxGamepadFrame(XBOX_GAMEPAD_EMPTY_FRAME, axes({ ly: -1 }), layout)).toEqual([
      { type: 'command', commandId: 'session.selectNext' },
    ]);
    expect(reduceXboxGamepadFrame(XBOX_GAMEPAD_EMPTY_FRAME, axes({ lx: -1 }), layout)).toEqual([
      { type: 'command', commandId: 'toggleSidebar' },
    ]);
    expect(reduceXboxGamepadFrame(XBOX_GAMEPAD_EMPTY_FRAME, axes({ lx: 1 }), layout)).toEqual([
      { type: 'command', commandId: 'toggleRightSidebar' },
    ]);
  });
});

describe('digitalTriggerPressed', () => {
  it('uses hysteresis so a noisy trigger does not chatter', () => {
    expect(digitalTriggerPressed(false, 0.5)).toBe(false);
    expect(digitalTriggerPressed(false, 0.55)).toBe(true);
    expect(digitalTriggerPressed(true, 0.45)).toBe(true);
    expect(digitalTriggerPressed(true, 0.4)).toBe(false);
  });
});

describe('xboxGamepadHoldReleases', () => {
  it('releases voice and scroll that were still held', () => {
    const layout = createXboxGamepadDefaultLayout();
    expect(
      xboxGamepadHoldReleases({ ...press('lt'), axes: { ...XBOX_GAMEPAD_EMPTY_FRAME.axes, ry: -1 } }, layout),
    ).toEqual([
      { type: 'voice', phase: 'release' },
      { type: 'scroll-stop' },
    ]);
  });
});
