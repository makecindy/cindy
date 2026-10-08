// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDefaultVoiceInputSettings,
  type VoiceInputSettings,
  type VoiceInputSettingsPatch,
} from '../../../shared/voiceInputData';
import { useVoiceInputSettings } from '../useVoiceInputSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from '@/lib/toast';

let settings: VoiceInputSettings;
let updateSettings: ReturnType<typeof vi.fn>;

function installElectronApi(): void {
  updateSettings = vi.fn(async () => settings);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'darwin',
      voiceInput: {
        getDataSnapshot: () => ({ settings }),
        updateSettings,
        setGlobalShortcut: vi.fn().mockResolvedValue({ ok: true }),
        onDataChanged: vi.fn(() => () => {}),
      },
    },
  });
}

describe('voice input override restore defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {
      ...getDefaultVoiceInputSettings('darwin'),
      composerLongPressEnabled: true,
      composerLongPressEnabledOverride: true,
      dictionarySyncEnabled: true,
      dictionarySyncEnabledOverride: true,
    };
    installElectronApi();
  });

  it('长按开关恢复默认提交 null 删除 override,成功后采纳返回的设置', async () => {
    const { result } = renderHook(() => useVoiceInputSettings());
    updateSettings.mockImplementation(async (patch: VoiceInputSettingsPatch) => {
      expect(patch).toEqual({ composerLongPressEnabled: null });
      const next = { ...settings };
      delete next.composerLongPressEnabledOverride;
      next.composerLongPressEnabled = false;
      return next;
    });

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.resetComposerLongPressEnabled();
    });

    expect(ok).toBe(true);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ composerLongPressEnabled: null });
    expect(result.current.settings.composerLongPressEnabled).toBe(false);
    expect(result.current.settings.composerLongPressEnabledOverride).toBeUndefined();
  });

  it('词典同步开关同一套约定:恢复默认提交 null', async () => {
    const { result } = renderHook(() => useVoiceInputSettings());
    updateSettings.mockImplementation(async (patch: VoiceInputSettingsPatch) => {
      expect(patch).toEqual({ dictionarySyncEnabled: null });
      const next = { ...settings };
      delete next.dictionarySyncEnabledOverride;
      next.dictionarySyncEnabled = false;
      return next;
    });

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.resetDictionarySyncEnabled();
    });

    expect(ok).toBe(true);
    expect(updateSettings).toHaveBeenCalledWith({ dictionarySyncEnabled: null });
    expect(result.current.settings.dictionarySyncEnabledOverride).toBeUndefined();
  });

  it('普通拨动仍写布尔有效值,不会顺手清掉 override 语义', async () => {
    const { result } = renderHook(() => useVoiceInputSettings());

    await act(async () => {
      result.current.setComposerLongPressEnabled(false);
    });

    expect(updateSettings).toHaveBeenCalledWith({ composerLongPressEnabled: false });
    expect(updateSettings).not.toHaveBeenCalledWith({ composerLongPressEnabled: null });
  });

  it('持久化失败时恢复默认返回 false 并提示,不谎报成功', async () => {
    const { result } = renderHook(() => useVoiceInputSettings());
    updateSettings.mockRejectedValue(new Error('ipc unavailable'));

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.resetComposerLongPressEnabled();
    });

    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(result.current.settings.composerLongPressEnabledOverride).toBe(true);
  });
});
