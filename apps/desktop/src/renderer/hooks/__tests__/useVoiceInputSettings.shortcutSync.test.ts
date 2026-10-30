// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDefaultVoiceInputSettings,
  type VoiceInputDataSnapshot,
  type VoiceInputSettings,
} from '../../../shared/voiceInputData';
import { useVoiceInputSettings } from '../useVoiceInputSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const shortcut = {
  trigger: 'keyboard' as const,
  code: 'Space',
  key: ' ',
  modifiers: { meta: false, ctrl: true, alt: false, shift: true, fn: false },
};

let settings: VoiceInputSettings;
let setGlobalShortcut: ReturnType<typeof vi.fn>;
let emitDataChanged: (snapshot: VoiceInputDataSnapshot) => void;

function installElectronApi(): void {
  setGlobalShortcut = vi.fn().mockResolvedValue({ ok: true });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'win32',
      voiceInput: {
        getDataSnapshot: () => ({ settings }),
        updateShortcutSetting: vi.fn(),
        updateSettings: vi.fn(),
        setGlobalShortcut,
        onDataChanged: vi.fn((listener: (snapshot: VoiceInputDataSnapshot) => void) => {
          emitDataChanged = listener;
          return () => {};
        }),
      },
    },
  });
}

describe('useVoiceInputSettings global shortcut sync', () => {
  beforeEach(() => {
    settings = { ...getDefaultVoiceInputSettings('win32'), shortcut };
    installElectronApi();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('does not re-sync when a data broadcast carries an equal shortcut object', async () => {
    renderHook(() => useVoiceInputSettings());
    expect(setGlobalShortcut).toHaveBeenCalledTimes(1);

    // Main clones the snapshot per broadcast (e.g. history append after a
    // dictation), so the shortcut arrives as a new object with the same value.
    await act(async () => {
      emitDataChanged({
        settings: { ...settings, shortcut: { ...shortcut, modifiers: { ...shortcut.modifiers } } },
        history: [],
      } as VoiceInputDataSnapshot);
    });

    expect(setGlobalShortcut).toHaveBeenCalledTimes(1);
  });

  it('re-syncs when the broadcast shortcut value actually changes', async () => {
    renderHook(() => useVoiceInputSettings());
    expect(setGlobalShortcut).toHaveBeenCalledTimes(1);

    const next = { ...shortcut, code: 'KeyV', key: 'v' };
    await act(async () => {
      emitDataChanged({ settings: { ...settings, shortcut: next }, history: [] } as VoiceInputDataSnapshot);
    });

    expect(setGlobalShortcut).toHaveBeenCalledTimes(2);
    expect(setGlobalShortcut).toHaveBeenLastCalledWith(next, undefined);
  });
});
