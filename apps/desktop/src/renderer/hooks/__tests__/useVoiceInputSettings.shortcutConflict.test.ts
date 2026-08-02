// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDefaultVoiceInputSettings,
  type VoiceInputSettings,
} from '../../../shared/voiceInputData';
import {
  COMPOSER_SEND_SHORTCUT_STORAGE_KEY,
  _resetComposerSendShortcutPreferenceForTests,
} from '../useComposerSendShortcutPreference';
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

const composerVoiceShortcut = {
  trigger: 'keyboard' as const,
  code: 'Enter',
  key: 'Enter',
  modifiers: { meta: true, ctrl: false, alt: false, shift: false, fn: false },
};

let settings: VoiceInputSettings;
let updateShortcutSetting: ReturnType<typeof vi.fn>;

function installElectronApi(): void {
  updateShortcutSetting = vi.fn(async (shortcut) => {
    settings = { ...settings, shortcut };
    return { ok: true, settings };
  });

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'darwin',
      voiceInput: {
        getDataSnapshot: () => ({ settings }),
        updateShortcutSetting,
        updateSettings: vi.fn(),
        setGlobalShortcut: vi.fn().mockResolvedValue({ ok: true }),
        onDataChanged: vi.fn(() => () => {}),
      },
    },
  });
}

describe('useVoiceInputSettings Composer conflict guard', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetComposerSendShortcutPreferenceForTests();
    settings = { ...getDefaultVoiceInputSettings('darwin'), shortcut: null };
    installElectronApi();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('rejects a conflicting shortcut before calling the persistence IPC', async () => {
    localStorage.setItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY, 'modifier-enter');

    const { result } = renderHook(() => useVoiceInputSettings());
    let updateResult!: Awaited<ReturnType<typeof result.current.setShortcut>>;

    await act(async () => {
      updateResult = await result.current.setShortcut(composerVoiceShortcut);
    });

    expect(updateResult).toEqual({
      ok: false,
      conflict: 'composer-voice-input',
      error: 'Voice Input shortcut conflicts with the Composer send shortcut',
    });
    expect(updateShortcutSetting).not.toHaveBeenCalled();
    expect(settings.shortcut).toBeNull();
  });

  it('allows a non-conflicting shortcut through the existing persistence path', async () => {
    localStorage.setItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY, 'modifier-enter');
    const nonConflictingShortcut = {
      ...composerVoiceShortcut,
      modifiers: { meta: false, ctrl: true, alt: false, shift: true, fn: false },
    };

    const { result } = renderHook(() => useVoiceInputSettings());
    await act(async () => {
      await result.current.setShortcut(nonConflictingShortcut);
    });

    expect(updateShortcutSetting).toHaveBeenCalledWith(nonConflictingShortcut);
    expect(settings.shortcut).toEqual(nonConflictingShortcut);
  });

  it('rechecks the current Composer preference when a recording commit is in flight', async () => {
    const { result } = renderHook(() => useVoiceInputSettings());

    localStorage.setItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY, 'modifier-enter');
    _resetComposerSendShortcutPreferenceForTests();

    let updateResult!: Awaited<ReturnType<typeof result.current.setShortcut>>;
    await act(async () => {
      updateResult = await result.current.setShortcut(composerVoiceShortcut);
    });

    expect(updateResult).toMatchObject({ ok: false, conflict: 'composer-voice-input' });
    expect(updateShortcutSetting).not.toHaveBeenCalled();
  });
});
