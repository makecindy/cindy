// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chatEmbeddingFailureKey,
  refreshChatEmbeddingFromMain,
  setChatEmbeddingSettingsOwner,
} from '../../lib/chatEmbeddingStore';
import {
  __testing as dataOwnerGenerationTesting,
  setDataOwnerGeneration,
} from '../../contexts/dataOwnerGeneration';
import { useChatEmbedding } from '../useChatEmbedding';

type Settings = {
  enabled: boolean;
  isCustomized?: boolean;
  defaultEnabled?: boolean;
};

describe('useChatEmbedding', () => {
  beforeEach(() => {
    dataOwnerGenerationTesting.reset();
    localStorage.clear();
    setChatEmbeddingSettingsOwner('__test-reset__', 1, false);
    setChatEmbeddingSettingsOwner(null, 2, false);
    localStorage.clear();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('subscribes before loading and ignores a stale availability snapshot', async () => {
    let resolveInitial!: (settings: Settings) => void;
    const listeners = new Set<() => void>();
    const chatEmbeddingGet = vi
      .fn<() => Promise<Settings>>()
      .mockReturnValueOnce(
        new Promise<Settings>((resolve) => {
          resolveInitial = resolve;
        }),
      )
      .mockResolvedValueOnce({ enabled: false, isCustomized: true, defaultEnabled: true });
    const maker = {
      chatEmbeddingGet,
      onProvidersChanged: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      onChatEmbeddingChanged: vi.fn(() => () => undefined),
    };
    (window as unknown as { electronAPI: { maker: typeof maker } }).electronAPI = { maker };

    const hook = renderHook(() => useChatEmbedding());
    expect(maker.onProvidersChanged.mock.invocationCallOrder[0]).toBeLessThan(
      chatEmbeddingGet.mock.invocationCallOrder[0],
    );
    act(() => {
      for (const listener of listeners) listener();
    });
    await waitFor(() => {
      expect(hook.result.current.enabled).toBe(false);
      expect(hook.result.current.isCustomized).toBe(true);
    });

    await act(async () => {
      resolveInitial({ enabled: true, isCustomized: false, defaultEnabled: true });
      await Promise.resolve();
    });
    expect(hook.result.current.enabled).toBe(false);
    expect(hook.result.current.isCustomized).toBe(true);

    hook.unmount();
    expect(listeners.size).toBe(0);
  });

  it('drops a delayed response from the previous data owner', async () => {
    let resolveOwnerA!: (settings: Settings) => void;
    const chatEmbeddingGet = vi
      .fn<() => Promise<Settings>>()
      .mockReturnValueOnce(
        new Promise<Settings>((resolve) => {
          resolveOwnerA = resolve;
        }),
      )
      .mockResolvedValueOnce({ enabled: false, isCustomized: false, defaultEnabled: false });
    const maker = {
      chatEmbeddingGet,
      onProvidersChanged: vi.fn(() => () => undefined),
      onChatEmbeddingChanged: vi.fn(() => () => undefined),
    };
    (window as unknown as { electronAPI: { maker: typeof maker } }).electronAPI = { maker };

    setChatEmbeddingSettingsOwner('owner-a', 3, true);
    const hook = renderHook(() => useChatEmbedding());
    expect(hook.result.current.enabled).toBe(true);

    act(() => {
      setChatEmbeddingSettingsOwner('owner-b', 4, false);
    });
    await act(async () => {
      await refreshChatEmbeddingFromMain();
    });
    expect(hook.result.current.enabled).toBe(false);

    await act(async () => {
      resolveOwnerA({ enabled: true, isCustomized: true, defaultEnabled: true });
      await Promise.resolve();
    });
    expect(hook.result.current).toMatchObject({
      enabled: false,
      isCustomized: false,
      defaultEnabled: false,
    });
  });

  it('does not let a provider refresh overwrite an optimistic mutation', async () => {
    let resolveRefresh!: (settings: Settings) => void;
    const listeners = new Set<() => void>();
    const chatEmbeddingGet = vi
      .fn<() => Promise<Settings>>()
      .mockResolvedValueOnce({ enabled: false, isCustomized: false, defaultEnabled: false })
      .mockReturnValueOnce(
        new Promise<Settings>((resolve) => {
          resolveRefresh = resolve;
        }),
      );
    const maker = {
      chatEmbeddingGet,
      onProvidersChanged: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      onChatEmbeddingChanged: vi.fn(() => () => undefined),
    };
    (window as unknown as { electronAPI: { maker: typeof maker } }).electronAPI = { maker };

    setChatEmbeddingSettingsOwner('owner-personal', 5, false);
    const hook = renderHook(() => useChatEmbedding());
    await waitFor(() => expect(chatEmbeddingGet).toHaveBeenCalledTimes(1));

    let token!: ReturnType<typeof hook.result.current.beginMutation>;
    act(() => {
      token = hook.result.current.beginMutation(true);
      for (const listener of listeners) listener();
    });
    expect(hook.result.current.enabled).toBe(true);

    await act(async () => {
      resolveRefresh({ enabled: false, isCustomized: false, defaultEnabled: false });
      await Promise.resolve();
    });
    expect(hook.result.current.enabled).toBe(true);

    act(() => {
      expect(
        hook.result.current.completeMutation(token, {
          enabled: true,
          isCustomized: true,
          defaultEnabled: false,
        }),
      ).toBe(true);
    });
    expect(hook.result.current).toMatchObject({ enabled: true, isCustomized: true });
  });

  it('replays a provider refresh that was deferred by a failed mutation', async () => {
    let resolveProviderRefresh!: (settings: Settings) => void;
    const listeners = new Set<() => void>();
    const chatEmbeddingGet = vi
      .fn<() => Promise<Settings>>()
      .mockResolvedValueOnce({ enabled: false, isCustomized: false, defaultEnabled: false })
      .mockReturnValueOnce(
        new Promise<Settings>((resolve) => {
          resolveProviderRefresh = resolve;
        }),
      )
      .mockResolvedValueOnce({ enabled: true, isCustomized: false, defaultEnabled: true });
    const maker = {
      chatEmbeddingGet,
      onProvidersChanged: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      onChatEmbeddingChanged: vi.fn(() => () => undefined),
    };
    (window as unknown as { electronAPI: { maker: typeof maker } }).electronAPI = { maker };

    setChatEmbeddingSettingsOwner('owner-org', 6, true);
    const hook = renderHook(() => useChatEmbedding());
    await waitFor(() => expect(chatEmbeddingGet).toHaveBeenCalledTimes(1));

    let token!: ReturnType<typeof hook.result.current.beginMutation>;
    act(() => {
      token = hook.result.current.beginMutation(false);
      for (const listener of listeners) listener();
    });
    await act(async () => {
      resolveProviderRefresh({ enabled: true, isCustomized: false, defaultEnabled: true });
      await Promise.resolve();
    });

    act(() => {
      expect(hook.result.current.rollbackMutation(token)).toBe(true);
    });
    await waitFor(() => {
      expect(chatEmbeddingGet).toHaveBeenCalledTimes(3);
      expect(hook.result.current).toMatchObject({
        enabled: true,
        isCustomized: false,
        defaultEnabled: true,
      });
    });
  });

  it('reconciles a cross-window storage update skipped during a mutation', async () => {
    const chatEmbeddingGet = vi
      .fn<() => Promise<Settings>>()
      .mockResolvedValueOnce({ enabled: false, isCustomized: false, defaultEnabled: false })
      .mockResolvedValueOnce({ enabled: false, isCustomized: true, defaultEnabled: true });
    const maker = {
      chatEmbeddingGet,
      onProvidersChanged: vi.fn(() => () => undefined),
      onChatEmbeddingChanged: vi.fn(() => () => undefined),
    };
    (window as unknown as { electronAPI: { maker: typeof maker } }).electronAPI = { maker };

    setChatEmbeddingSettingsOwner('owner-cross-window', 7, true);
    const hook = renderHook(() => useChatEmbedding());
    await waitFor(() => expect(chatEmbeddingGet).toHaveBeenCalledTimes(1));

    let token!: ReturnType<typeof hook.result.current.beginMutation>;
    act(() => {
      token = hook.result.current.beginMutation(true);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'chatEmbedding.settings.owner-cross-window',
        }),
      );
      expect(
        hook.result.current.completeMutation(token, {
          enabled: true,
          isCustomized: true,
          defaultEnabled: true,
        }),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(chatEmbeddingGet).toHaveBeenCalledTimes(2);
      expect(hook.result.current).toMatchObject({ enabled: false, isCustomized: true });
    });
  });

  it('refreshes only for a settings-changed push stamped to the active owner', async () => {
    let onSettingsChanged!: (stamp: {
      dataOwnerId: string | null;
      ownerGeneration: number;
    }) => void;
    const chatEmbeddingGet = vi
      .fn<() => Promise<Settings>>()
      .mockResolvedValueOnce({ enabled: false, isCustomized: true, defaultEnabled: true })
      .mockResolvedValueOnce({ enabled: true, isCustomized: true, defaultEnabled: true });
    const maker = {
      chatEmbeddingGet,
      onProvidersChanged: vi.fn(() => () => undefined),
      onChatEmbeddingChanged: vi.fn((listener: typeof onSettingsChanged) => {
        onSettingsChanged = listener;
        return () => undefined;
      }),
    };
    (window as unknown as { electronAPI: { maker: typeof maker } }).electronAPI = { maker };

    setDataOwnerGeneration('owner-push', 8);
    setChatEmbeddingSettingsOwner('owner-push', 8, true);
    const hook = renderHook(() => useChatEmbedding());
    await waitFor(() => expect(chatEmbeddingGet).toHaveBeenCalledTimes(1));

    act(() => {
      onSettingsChanged({ dataOwnerId: 'other-owner', ownerGeneration: 8 });
    });
    expect(chatEmbeddingGet).toHaveBeenCalledTimes(1);

    act(() => {
      onSettingsChanged({ dataOwnerId: 'owner-push', ownerGeneration: 8 });
    });
    await waitFor(() => {
      expect(chatEmbeddingGet).toHaveBeenCalledTimes(2);
      expect(hook.result.current.enabled).toBe(true);
    });
  });

  it('maps IPC failures to localized chat embedding messages', () => {
    expect(
      chatEmbeddingFailureKey(
        new Error('Error invoking remote method: Error: [UNSUPPORTED_CAPABILITY] raw detail'),
      ),
    ).toBe('settings.chatEmbedding.toast.unavailable');
    expect(chatEmbeddingFailureKey(new Error('[INTERNAL] raw detail'))).toBe(
      'settings.chatEmbedding.toast.toggleFailed',
    );
  });
});
