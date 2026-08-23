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

    controller.applySettings(enabledSettings());
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
    controller.applySettings(enabledSettings());
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
    controller.applySettings(enabledSettings());

    controller.handleHostMessage({ kind: 'host-error', message: 'swiftc failed' });
    expect(controller.getState().connectionStatus).toBe('error');
    expect(controller.getState().devicePresent).toBe(false);

    // A later presence report means the helper recovered.
    controller.handleHostMessage({ kind: 'presence', present: true, name: 'Xbox' });
    expect(controller.getState().connectionStatus).toBe('connected');
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
    expect(controller.getState().device).toEqual({
      name: 'Xbox Wireless Controller',
      category: 'Xbox One',
      transport: 'bluetooth',
      batteryPercentage: 64,
      batteryState: 'discharging',
    });
    controller.handleHostMessage({ kind: 'presence', present: false });
    expect(controller.getState().device.transport).toBe('unknown');
    expect(controller.getState().device.batteryPercentage).toBeNull();
  });
  it('previews input without dispatching while the layout editor is open', () => {
    const dispatch = vi.fn();
    const preview = vi.fn();
    const controller = new XboxGamepadController({
      isCindyFrontmost: () => true,
      dispatch,
      preview,
    });
    controller.applySettings(enabledSettings());
    controller.handleHostMessage({
      kind: 'frame',
      buttons: XBOX_GAMEPAD_EMPTY_FRAME.buttons,
      axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
      triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
    });
    controller.setLayoutPreviewActive(true);
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
      expect.objectContaining({ buttons: expect.objectContaining({ a: true }) }),
    );
  });

  it('does not broadcast preview frames until the layout editor holds the lease', () => {
    const preview = vi.fn();
    const controller = new XboxGamepadController({
      isCindyFrontmost: () => true,
      dispatch: vi.fn(),
      preview,
    });
    controller.applySettings(enabledSettings());
    controller.handleHostMessage({
      kind: 'frame',
      buttons: { ...XBOX_GAMEPAD_EMPTY_FRAME.buttons, a: true },
      axes: XBOX_GAMEPAD_EMPTY_FRAME.axes,
      triggers: XBOX_GAMEPAD_EMPTY_FRAME.triggers,
    });
    expect(preview).not.toHaveBeenCalled();
  });
});
