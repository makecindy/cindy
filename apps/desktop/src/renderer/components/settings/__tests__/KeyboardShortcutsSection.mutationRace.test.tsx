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
  getUnavailableIds: vi.fn(),
  listeners: new Set<() => void>(),
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
  getUnavailableAppShortcutIds: mocks.getUnavailableIds,
  subscribeAppShortcuts: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));

vi.mock('@/hooks/useVoiceInputSettings', () => ({
  getVoiceInputSettings: () => ({ shortcut: null }),
}));

import { KeyboardShortcutsSection } from '../KeyboardShortcutsSection';

describe('KeyboardShortcutsSection mutation ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.getUnavailableIds.mockReturnValue([]);
  });

  it('shows a row error when the global shortcut could not be registered at startup', () => {
    mocks.getOverrides.mockReturnValue({});
    mocks.getCombos.mockReturnValue([combo]);
    mocks.getUnavailableIds.mockReturnValue(['toggle-main-window']);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        appShortcuts: {
          setOverride: vi.fn(async () => ({ overrides: {} })),
          clearOverride: vi.fn(async () => ({ overrides: {} })),
          resetAll: vi.fn(async () => ({ overrides: {} })),
          setRecording: vi.fn(),
        },
      },
    });

    render(<KeyboardShortcutsSection />);
    expect(screen.getByText('settings.shortcuts.errors.globalUnavailable')).toBeTruthy();
  });

  it('clears the registration error when availability changes without an override change', () => {
    mocks.getOverrides.mockReturnValue({});
    mocks.getCombos.mockReturnValue([combo]);
    mocks.getUnavailableIds.mockReturnValue(['toggle-main-window']);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        appShortcuts: {
          setOverride: vi.fn(async () => ({ overrides: {} })),
          clearOverride: vi.fn(async () => ({ overrides: {} })),
          resetAll: vi.fn(async () => ({ overrides: {} })),
          setRecording: vi.fn(),
        },
      },
    });

    render(<KeyboardShortcutsSection />);
    expect(screen.getByText('settings.shortcuts.errors.globalUnavailable')).toBeTruthy();

    mocks.getUnavailableIds.mockReturnValue([]);
    act(() => mocks.listeners.forEach((listener) => listener()));
    expect(screen.queryByText('settings.shortcuts.errors.globalUnavailable')).toBeNull();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
    vi.restoreAllMocks();
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
