// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
  createWorkLouderCodexDefaultSettings,
} from '../../../../shared/workLouderCodex';
import {
  XBOX_GAMEPAD_EMPTY_DEVICE,
  createXboxGamepadDefaultSettings,
} from '../../../../shared/xboxGamepad';

const mocks = vi.hoisted(() => ({
  workLouderPresent: false as boolean | null,
  workLouderEnabled: false,
  xboxPresent: false as boolean | null,
  xboxEnabled: false,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('@/lib/appShortcutStore', () => ({
  getAppShortcutCombos: () => [],
  getAppShortcutOverrides: () => ({}),
  getAppShortcutPlatform: () => 'darwin',
  subscribeAppShortcuts: () => () => {},
}));

vi.mock('@/hooks/useVoiceInputSettings', () => ({
  getVoiceInputSettings: () => ({ shortcut: null }),
}));

vi.mock('@/features/skillhub/hooks/useSkillhub', () => ({
  useSkillhub: () => ({
    skills: [],
    bootstrapped: true,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useWorkLouderCodex', () => ({
  useWorkLouderCodex: () => ({
    state: {
      connectionStatus: mocks.workLouderPresent === true ? 'connected' : 'not-detected',
      connectionReason: null,
      devicePresent: mocks.workLouderPresent,
      device: { ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE },
      settings: {
        ...createWorkLouderCodexDefaultSettings(),
        deviceEnabled: mocks.workLouderEnabled,
      },
      agentSlots: [],
      taskOptions: [],
      agentSlotCount: 6,
    },
    loading: false,
    saving: false,
    error: null,
    setSettings: vi.fn(),
    resetSettings: vi.fn(),
    openInputMonitoringSettings: vi.fn(),
    reload: vi.fn(),
  }),
}));

vi.mock('@/hooks/useXboxGamepad', () => ({
  useXboxGamepad: () => ({
    state: {
      connectionStatus: mocks.xboxPresent === true ? 'connected' : 'not-detected',
      devicePresent: mocks.xboxPresent,
      deviceName: mocks.xboxPresent === true ? 'Xbox Wireless Controller' : null,
      device: { ...XBOX_GAMEPAD_EMPTY_DEVICE },
      settings: {
        ...createXboxGamepadDefaultSettings(),
        deviceEnabled: mocks.xboxEnabled,
      },
    },
    loading: false,
    saving: false,
    error: null,
    setSettings: vi.fn(),
    resetSettings: vi.fn(),
    reload: vi.fn(),
  }),
}));

import { KeyboardShortcutsSection } from '../KeyboardShortcutsSection';

describe('KeyboardShortcutsSection accessories', () => {
  beforeEach(() => {
    mocks.workLouderPresent = false;
    mocks.workLouderEnabled = false;
    mocks.xboxPresent = false;
    mocks.xboxEnabled = false;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onAuthStateChange: vi.fn(() => () => {}),
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('keeps undetected hardware behind a single Accessories entry', () => {
    render(<KeyboardShortcutsSection />);

    expect(screen.getByTestId('settings-shortcuts-accessories')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'settings.shortcuts.xboxGamepad.openAria' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settings.shortcuts.accessories.openAria' }));
    expect(
      screen.getByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'settings.shortcuts.xboxGamepad.openAria' }),
    ).toBeTruthy();
  });

  it('shows a detected device here and keeps the rest behind Accessories', () => {
    mocks.xboxPresent = true;
    render(<KeyboardShortcutsSection />);

    expect(
      screen.getByRole('button', { name: 'settings.shortcuts.xboxGamepad.openAria' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settings.shortcuts.accessories.openAria' }));
    expect(
      screen.getByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'settings.shortcuts.xboxGamepad.openAria' }),
    ).toBeNull();
  });

  it('shows an enabled device here even when it is not detected', () => {
    mocks.xboxEnabled = true;
    render(<KeyboardShortcutsSection />);

    expect(
      screen.getByRole('button', { name: 'settings.shortcuts.xboxGamepad.openAria' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    ).toBeNull();
    expect(screen.getByTestId('settings-shortcuts-accessories')).toBeTruthy();
  });

  it('hides Accessories when every hardware device is connected', () => {
    mocks.workLouderPresent = true;
    mocks.xboxPresent = true;
    render(<KeyboardShortcutsSection />);

    expect(screen.queryByTestId('settings-shortcuts-accessories')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'settings.shortcuts.xboxGamepad.openAria' }),
    ).toBeTruthy();
  });
});
