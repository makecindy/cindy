// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const combo = {
  code: 'KeyJ',
  meta: true,
  ctrl: false,
  alt: false,
  shift: false,
};

const mocks = vi.hoisted(() => ({
  getOverrides: vi.fn(),
  getCombos: vi.fn(),
  workLouderPresent: false as boolean,
}));

vi.mock('@/features/skillhub/hooks/useSkillhub', () => ({
  useSkillhub: () => ({
    skills: [],
    bootstrapped: true,
    refresh: vi.fn(async () => []),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('@/lib/appShortcutStore', () => ({
  getAppShortcutCombos: mocks.getCombos,
  getAppShortcutOverrides: mocks.getOverrides,
  getAppShortcutPlatform: () => 'darwin',
  subscribeAppShortcuts: () => () => {},
}));

vi.mock('@/hooks/useVoiceInputSettings', () => ({
  getVoiceInputSettings: () => ({ shortcut: null }),
}));

vi.mock('@/hooks/useWorkLouderCodex', async () => {
  const { WORKLOUDER_CODEX_EMPTY_DEVICE_STATE, createWorkLouderCodexDefaultSettings } =
    await import('../../../../shared/workLouderCodex');
  return {
    useWorkLouderCodex: () => ({
      state: {
        connectionStatus: mocks.workLouderPresent ? 'connected' : 'not-detected',
        connectionReason: null,
        devicePresent: mocks.workLouderPresent,
        device: { ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE },
        settings: createWorkLouderCodexDefaultSettings(),
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
  };
});

vi.mock('@/hooks/useXboxGamepad', async () => {
  const { XBOX_GAMEPAD_EMPTY_DEVICE, createXboxGamepadDefaultSettings } =
    await import('../../../../shared/xboxGamepad');
  return {
    useXboxGamepad: () => ({
      state: {
        connectionStatus: 'not-detected',
        devicePresent: false,
        deviceName: null,
        device: { ...XBOX_GAMEPAD_EMPTY_DEVICE },
        settings: createXboxGamepadDefaultSettings(),
      },
      loading: false,
      saving: false,
      error: null,
      setSettings: vi.fn(),
      resetSettings: vi.fn(),
      reload: vi.fn(),
    }),
  };
});

import { KeyboardShortcutsSection } from '../KeyboardShortcutsSection';

describe('KeyboardShortcutsSection mutation ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workLouderPresent = false;
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
    vi.restoreAllMocks();
  });

  it('opens the Work Louder device settings from the keyboard-shortcuts page', () => {
    mocks.getOverrides.mockReturnValue({});
    mocks.getCombos.mockReturnValue([]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onAuthStateChange: vi.fn(() => () => {}),
      },
    });

    mocks.workLouderPresent = true;
    render(<KeyboardShortcutsSection />);
    fireEvent.click(screen.getByLabelText('settings.shortcuts.workLouderCodex.openAria'));

    expect(screen.getByLabelText('settings.shortcuts.workLouderCodex.back')).toBeTruthy();
  });

  it('ignores an older mutation failure after a newer mutation succeeds', async () => {
    let rejectOlder!: (reason: unknown) => void;
    const olderRequest = new Promise<{ overrides: Record<string, unknown> }>((_resolve, reject) => {
      rejectOlder = reject;
    });
    const setOverride = vi.fn(() => olderRequest);
    const clearOverride = vi.fn(async () => ({ overrides: {} }));
    mocks.getOverrides.mockReturnValue({ 'toggle-sidebar': combo });
    mocks.getCombos.mockReturnValue([combo]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onAuthStateChange: vi.fn(() => () => {}),
        appShortcuts: {
          setOverride,
          clearOverride,
          resetAll: vi.fn(async () => ({ overrides: {} })),
          setRecording: vi.fn(),
        },
      },
    });

    render(<KeyboardShortcutsSection />);
    fireEvent.click(screen.getAllByTitle('settings.shortcuts.delete')[0]!);
    fireEvent.click(screen.getByTitle('settings.shortcuts.reset'));
    await vi.waitFor(() => expect(clearOverride).toHaveBeenCalledTimes(1));

    await act(async () => {
      rejectOlder(new Error('[APP_SHORTCUTS_WRITE_FAILED] older request failed'));
      await Promise.resolve();
    });

    expect(screen.queryByText('settings.shortcuts.errors.saveFailed')).toBeNull();
  });

  it('keeps a newer local validation error when an older mutation fails', async () => {
    let rejectOlder!: (reason: unknown) => void;
    const olderRequest = new Promise<{ overrides: Record<string, unknown> }>((_resolve, reject) => {
      rejectOlder = reject;
    });
    const setOverride = vi.fn(() => olderRequest);
    mocks.getOverrides.mockReturnValue({ 'toggle-sidebar': combo });
    mocks.getCombos.mockReturnValue([combo]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onAuthStateChange: vi.fn(() => () => {}),
        appShortcuts: {
          setOverride,
          clearOverride: vi.fn(async () => ({ overrides: {} })),
          resetAll: vi.fn(async () => ({ overrides: {} })),
          setRecording: vi.fn(),
        },
      },
    });

    render(<KeyboardShortcutsSection />);
    fireEvent.click(screen.getAllByTitle('settings.shortcuts.delete')[0]!);
    fireEvent.click(screen.getAllByTitle('settings.shortcuts.edit')[1]!);
    await vi.waitFor(() => expect(document.body.dataset.appShortcutRecording).toBe('1'));
    fireEvent.keyDown(window, { key: 'q', code: 'KeyQ' });
    await vi.waitFor(() => {
      expect(screen.getByText('settings.shortcuts.errors.notBindable')).toBeTruthy();
    });

    await act(async () => {
      rejectOlder(new Error('[APP_SHORTCUTS_WRITE_FAILED] older request failed'));
      await Promise.resolve();
    });

    expect(screen.getByText('settings.shortcuts.errors.notBindable')).toBeTruthy();
    expect(screen.queryByText('settings.shortcuts.errors.saveFailed')).toBeNull();
  });
});
