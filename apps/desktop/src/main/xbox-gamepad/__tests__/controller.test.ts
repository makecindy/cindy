import { describe, expect, it, vi } from 'vitest';

import { createXboxGamepadDefaultSettings } from '../../../shared/xboxGamepad.js';
import { XBOX_GAMEPAD_EMPTY_FRAME } from '../bindings.js';
import { XboxGamepadController } from '../controller.js';

function enabledSettings() {
  return { ...createXboxGamepadDefaultSettings(), deviceEnabled: true };
}

describe('XboxGamepadController', () => {
  it('ignores input until the adapter is enabled and Cindy is frontmost', () => {
    const dispatch = vi.fn();
    const preview = vi.fn();
    const frontmost = { value: false };
    const controller = new XboxGamepadController({
      isCindyFrontmost: () => frontmost.value,
      dispatch,
      preview,
    });

    controller.handleHostMessage({
      kind: 'presence',
      present: true,
      name: 'Xbox Wireless Controller',
    });
    controller.handleHostMessage({
      kind: 'frame',
      buttons: { ...XBOX_GAMEPAD_EMPTY_FRAME.buttons, a: true },
      axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
      triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();

    controller.applySettings('xbox', enabledSettings());
    controller.handleHostMessage({
      kind: 'frame',
      buttons: { ...XBOX_GAMEPAD_EMPTY_FRAME.buttons, a: true },
      axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
      triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
    });
    expect(dispatch).not.toHaveBeenCalled();

    frontmost.value = true;
    controller.handleHostMessage({
      kind: 'frame',
      buttons: XBOX_GAMEPAD_EMPTY_FRAME.buttons,
      axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
      triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
    });
    controller.handleHostMessage({
      kind: 'frame',
      buttons: { ...XBOX_GAMEPAD_EMPTY_FRAME.buttons, a: true },
      axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
      triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
    });
    expect(dispatch).toHaveBeenCalledWith({ type: 'command', commandId: 'composer.submit' });
  });

  it('releases holds when Cindy leaves the foreground', () => {
    const dispatch = vi.fn();
    const controller = new XboxGamepadController({
      isCindyFrontmost: () => true,
      dispatch,
    });
    controller.applySettings('xbox', enabledSettings());
    controller.handleHostMessage({
      kind: 'frame',
      buttons: XBOX_GAMEPAD_EMPTY_FRAME.buttons,
      axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
      triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
    });
    controller.handleHostMessage({
      kind: 'frame',
      buttons: { ...XBOX_GAMEPAD_EMPTY_FRAME.buttons, lt: true },
      axes: { lx: 0, ly: 0, rx: 0, ry: 1 },
      triggers: { lt: 1, rt: 0 },
    });
    dispatch.mockClear();

    controller.setCindyFrontmost(false);
    expect(dispatch).toHaveBeenCalledWith({ type: 'voice', phase: 'release' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'scroll-stop' });
  });

  it('reports a helper failure as an error, not as a missing controller', () => {
    const controller = new XboxGamepadController({
      isCindyFrontmost: () => true,
      dispatch: vi.fn(),
    });
    controller.applySettings('xbox', enabledSettings());

    controller.handleHostMessage({ kind: 'host-error', message: 'swiftc failed' });
    expect(controller.getState('xbox').connectionStatus).toBe('error');
    expect(controller.getState('xbox').devicePresent).toBe(false);

    controller.handleHostMessage({ kind: 'presence', present: true, name: 'Xbox' });
    expect(controller.getState('xbox').connectionStatus).toBe('connected');
  });

  it('surfaces transport and battery from the helper presence report', () => {
    const controller = new XboxGamepadController({
      isCindyFrontmost: () => true,
      dispatch: vi.fn(),
    });
    controller.handleHostMessage({
      kind: 'presence',
      present: true,
      name: 'Xbox Wireless Controller',
      category: 'Xbox One',
      transport: 'bluetooth',
      batteryPercentage: 64,
      batteryState: 'discharging',
    });
    expect(controller.getState('xbox').device).toEqual({
      name: 'Xbox Wireless Controller',
      category: 'Xbox One',
      family: 'xbox',
      transport: 'bluetooth',
      batteryPercentage: 64,
      batteryState: 'discharging',
    });
    controller.handleHostMessage({ kind: 'presence', present: false });
    expect(controller.getState('xbox').device.transport).toBe('unknown');
    expect(controller.getState('xbox').device.batteryPercentage).toBeNull();
    expect(controller.getState('xbox').device.family).toBe('xbox');
  });

  it('keeps DualSense and Switch on their own accessories', () => {
    const controller = new XboxGamepadController({
      isCindyFrontmost: () => true,
      dispatch: vi.fn(),
    });
    controller.handleHostMessage({
      kind: 'presence',
      present: true,
      name: 'DualSense Wireless Controller',
      category: 'DualSense',
      family: 'playstation',
    });
    expect(controller.getState('playstation').devicePresent).toBe(true);
    expect(controller.getState('xbox').devicePresent).toBeNull();

    controller.handleHostMessage({
      kind: 'presence',
      present: true,
      name: 'Pro Controller',
      category: 'Nintendo Switch',
    });
    expect(controller.getState('nintendo').devicePresent).toBe(true);
    expect(controller.getState('playstation').devicePresent).toBe(true);
    expect(controller.getState('xbox').devicePresent).toBeNull();
    expect(controller.getState('generic').devicePresent).toBeNull();
  });

  it('keeps unrecognized pads on the generic accessory', () => {
    const controller = new XboxGamepadController({
      isCindyFrontmost: () => true,
      dispatch: vi.fn(),
    });
    controller.handleHostMessage({
      kind: 'presence',
      present: true,
      name: '8BitDo Pro 2',
      category: 'Extended Gamepad',
    });
    expect(controller.getState('generic').devicePresent).toBe(true);
    expect(controller.getState('generic').device.family).toBe('generic');
    expect(controller.getState('xbox').devicePresent).toBeNull();
  });

  it('previews input without dispatching while the layout editor is open', () => {
    const dispatch = vi.fn();
    const preview = vi.fn();
    const controller = new XboxGamepadController({
      isCindyFrontmost: () => true,
      dispatch,
      preview,
    });
    controller.applySettings('xbox', enabledSettings());
    controller.handleHostMessage({
      kind: 'frame',
      buttons: XBOX_GAMEPAD_EMPTY_FRAME.buttons,
      axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
      triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
    });
    controller.setLayoutPreviewActive(true, 'xbox');
    dispatch.mockClear();
    preview.mockClear();

    controller.handleHostMessage({
      kind: 'frame',
      buttons: { ...XBOX_GAMEPAD_EMPTY_FRAME.buttons, a: true },
      axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
      triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'xbox', buttons: expect.objectContaining({ a: true }) }),
    );
  });

  it('does not broadcast preview frames until the layout editor holds the lease', () => {
    const preview = vi.fn();
    const controller = new XboxGamepadController({
      isCindyFrontmost: () => true,
      dispatch: vi.fn(),
      preview,
    });
    controller.applySettings('xbox', enabledSettings());
    controller.handleHostMessage({
      kind: 'frame',
      buttons: { ...XBOX_GAMEPAD_EMPTY_FRAME.buttons, a: true },
      axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
      triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
    });
    expect(preview).not.toHaveBeenCalled();
  });

  it('releases every family hold when layout preview starts', () => {
    const dispatch = vi.fn();
    const controller = new XboxGamepadController({
      isCindyFrontmost: () => true,
      dispatch,
    });
    controller.applySettings('xbox', enabledSettings());
    controller.applySettings('playstation', enabledSettings());
    for (const family of ['xbox', 'playstation'] as const) {
      controller.handleHostMessage({
        kind: 'frame',
        family,
        buttons: XBOX_GAMEPAD_EMPTY_FRAME.buttons,
        axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
        triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
      });
      controller.handleHostMessage({
        kind: 'frame',
        family,
        buttons: { ...XBOX_GAMEPAD_EMPTY_FRAME.buttons, lt: true },
        axes: { lx: 0, ly: 0, rx: 0, ry: 1 },
        triggers: { lt: 1, rt: 0 },
      });
    }
    dispatch.mockClear();

    controller.setLayoutPreviewActive(true, 'xbox');
    expect(dispatch).toHaveBeenCalledWith({ type: 'voice', phase: 'release' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'scroll-stop' });
  });

  it('keeps the other pad voice and scroll when one family releases', () => {
    const dispatch = vi.fn();
    const controller = new XboxGamepadController({
      isCindyFrontmost: () => true,
      dispatch,
    });
    controller.applySettings('xbox', enabledSettings());
    controller.applySettings('playstation', enabledSettings());
    for (const family of ['xbox', 'playstation'] as const) {
      controller.handleHostMessage({
        kind: 'frame',
        family,
        buttons: XBOX_GAMEPAD_EMPTY_FRAME.buttons,
        axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
        triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
      });
      controller.handleHostMessage({
        kind: 'frame',
        family,
        buttons: { ...XBOX_GAMEPAD_EMPTY_FRAME.buttons, lt: true },
        axes: { lx: 0, ly: 0, rx: 0, ry: 1 },
        triggers: { lt: 1, rt: 0 },
      });
    }
    dispatch.mockClear();

    controller.handleHostMessage({
      kind: 'frame',
      family: 'xbox',
      buttons: XBOX_GAMEPAD_EMPTY_FRAME.buttons,
      axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
      triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'voice', phase: 'release' });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'scroll-stop' });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scroll', direction: 'up' }),
    );

    dispatch.mockClear();
    controller.handleHostMessage({
      kind: 'frame',
      family: 'playstation',
      buttons: XBOX_GAMEPAD_EMPTY_FRAME.buttons,
      axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
      triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
    });
    expect(dispatch).toHaveBeenCalledWith({ type: 'voice', phase: 'release' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'scroll-stop' });
  });
});
