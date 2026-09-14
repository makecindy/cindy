import { describe, expect, it, vi } from 'vitest';

import {
  createXboxGamepadDefaultSettings,
  emptyGamepadDevice,
  GAMEPAD_FAMILIES,
  type GamepadAccessoriesState,
  type XboxGamepadSettings,
} from '../../../shared/xboxGamepad.js';
import { createXboxGamepadSettingsIpc } from '../settingsIpc.js';

function accessories(settings: XboxGamepadSettings): GamepadAccessoriesState {
  return Object.fromEntries(
    GAMEPAD_FAMILIES.map((family) => [
      family,
      {
        connectionStatus: 'disabled' as const,
        devicePresent: true,
        deviceName: family,
        device: emptyGamepadDevice(family),
        settings,
      },
    ]),
  ) as GamepadAccessoriesState;
}

describe('Xbox gamepad settings IPC', () => {
  it('enables one accessory through a trusted sender', () => {
    let settings = createXboxGamepadDefaultSettings();
    const applySettings = vi.fn();
    const handlers = createXboxGamepadSettingsIpc({
      assertTrustedSender: vi.fn(),
      getState: () => accessories(settings),
      writeSettings: (_family, patch) => {
        settings = { ...settings, ...patch, layout: patch.layout ?? settings.layout };
        return settings;
      },
      resetSettings: () => {
        settings = createXboxGamepadDefaultSettings();
        return settings;
      },
      applySettings,
      probeDevice: vi.fn(),
      setLayoutPreviewActive: vi.fn(),
    });

    const next = handlers.set({}, 'playstation', { deviceEnabled: true });
    expect(next.playstation.settings.deviceEnabled).toBe(true);
    expect(applySettings).toHaveBeenCalledWith(
      'playstation',
      expect.objectContaining({ deviceEnabled: true }),
    );
  });

  it('accepts a remapped layout', () => {
    let settings = createXboxGamepadDefaultSettings();
    const handlers = createXboxGamepadSettingsIpc({
      assertTrustedSender: vi.fn(),
      getState: () => accessories(settings),
      writeSettings: (_family, patch) => {
        settings = { ...settings, ...patch, layout: patch.layout ?? settings.layout };
        return settings;
      },
      resetSettings: () => settings,
      applySettings: vi.fn(),
      probeDevice: vi.fn(),
      setLayoutPreviewActive: vi.fn(),
    });
    const layout = createXboxGamepadDefaultSettings().layout;
    layout.buttons.a = { type: 'command', commandId: 'newTask' };
    const next = handlers.set({}, 'xbox', { layout });
    expect(next.xbox.settings.layout.buttons.a).toEqual({ type: 'command', commandId: 'newTask' });
  });

  it('rejects unknown settings keys', () => {
    const handlers = createXboxGamepadSettingsIpc({
      assertTrustedSender: vi.fn(),
      getState: vi.fn(),
      writeSettings: vi.fn(),
      resetSettings: vi.fn(),
      applySettings: vi.fn(),
      probeDevice: vi.fn(),
      setLayoutPreviewActive: vi.fn(),
    });
    expect(() => handlers.set({}, 'xbox', { rumble: true })).toThrow('[INVALID_PARAMS]');
  });

  it('forwards the renderer event when toggling layout preview', () => {
    const setLayoutPreviewActive = vi.fn();
    const event = { sender: { id: 9 } };
    const handlers = createXboxGamepadSettingsIpc({
      assertTrustedSender: vi.fn(),
      getState: vi.fn(),
      writeSettings: vi.fn(),
      resetSettings: vi.fn(),
      applySettings: vi.fn(),
      probeDevice: vi.fn(),
      setLayoutPreviewActive,
    });

    handlers.setLayoutPreviewActive(event, true);
    expect(setLayoutPreviewActive).toHaveBeenCalledWith(true, 'xbox', event);
    handlers.setLayoutPreviewActive(event, { active: true, family: 'nintendo' });
    expect(setLayoutPreviewActive).toHaveBeenCalledWith(true, 'nintendo', event);
  });
});
