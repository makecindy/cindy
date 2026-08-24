// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createXboxGamepadDefaultSettings,
  type XboxGamepadSettings as XboxGamepadSettingsModel,
  type XboxGamepadState,
} from '../../../../shared/xboxGamepad';

const mocks = vi.hoisted(() => ({
  state: null as XboxGamepadState | null,
  loading: true,
  saving: false,
  error: null as 'load' | 'save' | null,
  setSettings: vi.fn(),
  resetSettings: vi.fn(),
  reload: vi.fn(),
  setLayoutPreviewActive: vi.fn(),
  previewListeners: [] as Array<(input: unknown) => void>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useXboxGamepad', () => ({
  useXboxGamepad: () => ({
    state: mocks.state,
    loading: mocks.loading,
    saving: mocks.saving,
    error: mocks.error,
    setSettings: mocks.setSettings,
    resetSettings: mocks.resetSettings,
    reload: mocks.reload,
  }),
}));

vi.mock('@/features/skillhub/hooks/useSkillhub', () => ({
  useSkillhub: () => ({
    skills: [],
    bootstrapped: true,
    refresh: vi.fn(),
  }),
}));

import { XboxGamepadSettings } from '../XboxGamepadSettings';

function loadedState(
  settings: XboxGamepadSettingsModel = createXboxGamepadDefaultSettings(),
): XboxGamepadState {
  return {
    connectionStatus: 'connected',
    devicePresent: true,
    deviceName: 'Xbox Wireless Controller',
    device: {
      name: 'Xbox Wireless Controller',
      category: 'Xbox One',
      transport: 'usb',
      batteryPercentage: 80,
      batteryState: 'discharging',
    },
    settings,
  };
}

describe('XboxGamepadSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = null;
    mocks.loading = true;
    mocks.saving = false;
    mocks.error = null;
    mocks.previewListeners = [];
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        xboxGamepad: {
          setLayoutPreviewActive: mocks.setLayoutPreviewActive,
          onPreviewInput: (callback: (input: unknown) => void) => {
            mocks.previewListeners.push(callback);
            return () => {
              mocks.previewListeners = mocks.previewListeners.filter((item) => item !== callback);
            };
          },
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('renders the controller while settings are still loading', () => {
    expect(() => render(<XboxGamepadSettings onBack={vi.fn()} />)).not.toThrow();
    expect(screen.getByTestId('xbox-gamepad-layout')).toBeTruthy();
  });

  it('renders the controller when a live state is missing layout', () => {
    mocks.state = loadedState({ deviceEnabled: true } as XboxGamepadSettingsModel);
    mocks.loading = false;
    expect(() => render(<XboxGamepadSettings onBack={vi.fn()} />)).not.toThrow();
    expect(screen.getByTestId('xbox-gamepad-layout')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /settings.shortcuts.xboxGamepad.controls.a/ }),
    ).toBeTruthy();
  });
});
