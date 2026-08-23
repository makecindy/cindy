import { describe, expect, it, vi } from 'vitest';

import { createXboxGamepadDefaultSettings } from '../../../shared/xboxGamepad.js';
import { createXboxGamepadSettingsIpc } from '../settingsIpc.js';

describe('Xbox gamepad settings IPC', () => {
  it('enables the adapter through a trusted sender', () => {
    let settings = createXboxGamepadDefaultSettings();
    const applySettings = vi.fn();
    const handlers = createXboxGamepadSettingsIpc({
      assertTrustedSender: vi.fn(),
      getState: () => ({
        connectionStatus: 'disabled',
        devicePresent: true,
        deviceName: 'Xbox Wireless Controller',
        device: {
          name: 'Xbox Wireless Controller',
          category: 'Xbox One',
          transport: 'unknown',
          batteryPercentage: null,
          batteryState: 'unknown',
        },
        settings,
      }),
      writeSettings: (patch) => {
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

    const next = handlers.set({}, { deviceEnabled: true });
    expect(next.settings.deviceEnabled).toBe(true);
    expect(applySettings).toHaveBeenCalledWith(expect.objectContaining({ deviceEnabled: true }));
  });

  it('accepts a remapped layout', () => {
    let settings = createXboxGamepadDefaultSettings();
    const handlers = createXboxGamepadSettingsIpc({
      assertTrustedSender: vi.fn(),
      getState: () => ({
        connectionStatus: 'disabled',
        devicePresent: true,
        deviceName: 'Xbox Wireless Controller',
        device: {
          name: 'Xbox Wireless Controller',
          category: 'Xbox One',
          transport: 'unknown',
          batteryPercentage: null,
          batteryState: 'unknown',
        },
        settings,
      }),
      writeSettings: (patch) => {
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
    const next = handlers.set({}, { layout });
    expect(next.settings.layout.buttons.a).toEqual({ type: 'command', commandId: 'newTask' });
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
    expect(() => handlers.set({}, { rumble: true })).toThrow('[INVALID_PARAMS]');
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
    expect(setLayoutPreviewActive).toHaveBeenCalledWith(true, event);
  });
});
