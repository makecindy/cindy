// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
  createWorkLouderCodexDefaultSettings,
} from '../../../../shared/workLouderCodex';
import {
  emptyGamepadDevice,
  createXboxGamepadDefaultSettings,
  type GamepadFamily,
} from '../../../../shared/xboxGamepad';

const mocks = vi.hoisted(() => ({
  workLouderPresent: false as boolean | null,
  workLouderEnabled: false,
  present: {
    xbox: false as boolean | null,
    playstation: false as boolean | null,
    nintendo: false as boolean | null,
    generic: false as boolean | null,
  },
  enabled: {
    xbox: false,
    playstation: false,
    nintendo: false,
    generic: false,
  },
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
  useXboxGamepad: ({ family = 'xbox' }: { family?: GamepadFamily } = {}) => ({
    state: {
      connectionStatus: mocks.present[family] === true ? 'connected' : 'not-detected',
      devicePresent: mocks.present[family],
      deviceName: mocks.present[family] === true ? family : null,
      device: emptyGamepadDevice(family),
      settings: {
        ...createXboxGamepadDefaultSettings(),
        deviceEnabled: mocks.enabled[family],
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

const GAMEPAD_OPEN = {
  xbox: 'settings.shortcuts.xboxGamepad.openAria',
  playstation: 'settings.shortcuts.playstationGamepad.openAria',
  nintendo: 'settings.shortcuts.nintendoGamepad.openAria',
  generic: 'settings.shortcuts.genericGamepad.openAria',
} as const;

describe('KeyboardShortcutsSection accessories', () => {
  beforeEach(() => {
    mocks.workLouderPresent = false;
    mocks.workLouderEnabled = false;
    mocks.present.xbox = false;
    mocks.present.playstation = false;
    mocks.present.nintendo = false;
    mocks.present.generic = false;
    mocks.enabled.xbox = false;
    mocks.enabled.playstation = false;
    mocks.enabled.nintendo = false;
    mocks.enabled.generic = false;
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
    expect(screen.queryByRole('button', { name: GAMEPAD_OPEN.xbox })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settings.shortcuts.accessories.openAria' }));
    expect(
      screen.getByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: GAMEPAD_OPEN.xbox })).toBeTruthy();
    expect(screen.getByRole('button', { name: GAMEPAD_OPEN.playstation })).toBeTruthy();
    expect(screen.queryByRole('button', { name: GAMEPAD_OPEN.nintendo })).toBeNull();
    expect(screen.queryByRole('button', { name: GAMEPAD_OPEN.generic })).toBeNull();
  });

  it('shows a detected device here and keeps the rest behind Accessories', () => {
    mocks.present.xbox = true;
    render(<KeyboardShortcutsSection />);

    expect(screen.getByRole('button', { name: GAMEPAD_OPEN.xbox })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settings.shortcuts.accessories.openAria' }));
    expect(
      screen.getByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: GAMEPAD_OPEN.xbox })).toBeNull();
    expect(screen.getByRole('button', { name: GAMEPAD_OPEN.playstation })).toBeTruthy();
    expect(screen.queryByRole('button', { name: GAMEPAD_OPEN.nintendo })).toBeNull();
    expect(screen.queryByRole('button', { name: GAMEPAD_OPEN.generic })).toBeNull();
  });

  it('shows an enabled device here even when it is not detected', () => {
    mocks.enabled.xbox = true;
    render(<KeyboardShortcutsSection />);

    expect(screen.getByRole('button', { name: GAMEPAD_OPEN.xbox })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    ).toBeNull();
    expect(screen.getByTestId('settings-shortcuts-accessories')).toBeTruthy();
  });

  it('hides Accessories when every hardware device is connected', () => {
    mocks.workLouderPresent = true;
    mocks.present.xbox = true;
    mocks.present.playstation = true;
    mocks.present.nintendo = true;
    mocks.present.generic = true;
    render(<KeyboardShortcutsSection />);

    expect(screen.queryByTestId('settings-shortcuts-accessories')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: GAMEPAD_OPEN.xbox })).toBeTruthy();
    expect(screen.getByRole('button', { name: GAMEPAD_OPEN.playstation })).toBeTruthy();
    expect(screen.queryByRole('button', { name: GAMEPAD_OPEN.nintendo })).toBeNull();
    expect(screen.queryByRole('button', { name: GAMEPAD_OPEN.generic })).toBeNull();
  });

  it('does not surface Switch or generic accessories even when they are present', () => {
    mocks.present.nintendo = true;
    mocks.present.generic = true;
    mocks.enabled.nintendo = true;
    mocks.enabled.generic = true;
    render(<KeyboardShortcutsSection />);

    expect(screen.queryByRole('button', { name: GAMEPAD_OPEN.nintendo })).toBeNull();
    expect(screen.queryByRole('button', { name: GAMEPAD_OPEN.generic })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'settings.shortcuts.accessories.openAria' }));
    expect(screen.queryByRole('button', { name: GAMEPAD_OPEN.nintendo })).toBeNull();
    expect(screen.queryByRole('button', { name: GAMEPAD_OPEN.generic })).toBeNull();
  });
});
