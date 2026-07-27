import { describe, expect, it, vi } from 'vitest';

import {
  persistVoiceInputSelectionWithCustomAsrSecret,
  type CustomAsrSecretStore,
} from '../voiceInputCustomAsrPersistence.js';

function createSecretStore(initial: string | null): CustomAsrSecretStore & {
  value: string | null;
} {
  return {
    value: initial,
    get: vi.fn(function (this: { value: string | null }) {
      return this.value;
    }),
    set: vi.fn(function (this: { value: string | null }, _id, value) {
      this.value = value;
      return true;
    }),
    remove: vi.fn(function (this: { value: string | null }) {
      this.value = null;
      return { success: true };
    }),
  };
}

describe('custom ASR model-selection persistence', () => {
  it('does not write config when safeStorage rejects the new key', () => {
    const store = createSecretStore('old-key');
    vi.mocked(store.set).mockReturnValueOnce(false);
    const persistSelection = vi.fn(() => 'saved');

    expect(() => persistVoiceInputSelectionWithCustomAsrSecret(
      persistSelection,
      store,
      { action: 'set', value: 'new-key' },
    )).toThrow('Failed to store');
    expect(persistSelection).not.toHaveBeenCalled();
    expect(store.value).toBe('old-key');
  });

  it('restores the previous key when config persistence fails', () => {
    const store = createSecretStore('old-key');
    const persistSelection = vi.fn(() => {
      throw new Error('config write failed');
    });

    expect(() => persistVoiceInputSelectionWithCustomAsrSecret(
      persistSelection,
      store,
      { action: 'set', value: 'new-key' },
    )).toThrow('config write failed');
    expect(store.value).toBe('old-key');
    expect(store.set).toHaveBeenNthCalledWith(1, 'voice-asr', 'new-key');
    expect(store.set).toHaveBeenNthCalledWith(2, 'voice-asr', 'old-key');
  });

  it('restores a removed key when config persistence fails', () => {
    const store = createSecretStore('old-key');
    const persistSelection = vi.fn(() => {
      throw new Error('config write failed');
    });

    expect(() => persistVoiceInputSelectionWithCustomAsrSecret(
      persistSelection,
      store,
      { action: 'clear' },
    )).toThrow('config write failed');
    expect(store.value).toBe('old-key');
    expect(store.remove).toHaveBeenCalledWith('voice-asr');
    expect(store.set).toHaveBeenCalledWith('voice-asr', 'old-key');
  });

  it('preserves the config write error when restoring the previous key also fails', () => {
    const store = createSecretStore('old-key');
    vi.mocked(store.set)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(store.remove).mockReturnValue({ success: false });
    const configError = new Error('config write failed');

    let thrown: unknown;
    try {
      persistVoiceInputSelectionWithCustomAsrSecret(
        () => {
          throw configError;
        },
        store,
        { action: 'set', value: 'new-key' },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('restore the previous ASR key');
    expect((thrown as Error & { cause?: unknown }).cause).toBe(configError);
  });

  it('clears the uncertain key when restore fails but quarantine succeeds', () => {
    const store = createSecretStore('old-key');
    vi.mocked(store.set)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const configError = new Error('config write failed');

    expect(() => persistVoiceInputSelectionWithCustomAsrSecret(
      () => {
        throw configError;
      },
      store,
      { action: 'set', value: 'new-key' },
    )).toThrow('the ASR key was cleared');
    expect(store.value).toBeNull();
    expect(store.remove).toHaveBeenCalledWith('voice-asr');
  });

  it('commits both key and selection when both writes succeed', () => {
    const store = createSecretStore(null);
    const persistSelection = vi.fn(() => ({ ok: true }));

    expect(persistVoiceInputSelectionWithCustomAsrSecret(
      persistSelection,
      store,
      { action: 'set', value: 'new-key' },
    )).toEqual({ ok: true });
    expect(store.value).toBe('new-key');
  });
});
