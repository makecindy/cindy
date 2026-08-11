// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { chatEmbeddingFailureKey } from '../../lib/chatEmbeddingStore';
import { useChatEmbedding } from '../useChatEmbedding';

type Settings = {
  enabled: boolean;
  isCustomized?: boolean;
  defaultEnabled?: boolean;
};

describe('useChatEmbedding', () => {
  beforeEach(() => {
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
    };
    (window as unknown as { electronAPI: { maker: typeof maker } }).electronAPI = { maker };

    const hook = renderHook(() => useChatEmbedding());
    expect(maker.onProvidersChanged.mock.invocationCallOrder[0]).toBeLessThan(
      chatEmbeddingGet.mock.invocationCallOrder[0],
    );
    act(() => {
      for (const listener of listeners) listener();
    });
    await waitFor(() => expect(hook.result.current.enabled).toBe(false));
    expect(hook.result.current.isCustomized).toBe(true);

    await act(async () => {
      resolveInitial({ enabled: true, isCustomized: false, defaultEnabled: true });
      await Promise.resolve();
    });
    expect(hook.result.current.enabled).toBe(false);
    expect(hook.result.current.isCustomized).toBe(true);

    hook.unmount();
    expect(listeners.size).toBe(0);
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
