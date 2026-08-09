// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {
    listener: undefined as (() => void) | undefined,
    secondary: false,
  },
  consume: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  toastInfo: vi.fn(),
  translate: vi.fn((key: string) => key),
  warn: vi.fn(),
}));

vi.mock('@/i18n', () => ({ i18n: { t: mocks.translate } }));
vi.mock('@/lib/secondaryWindow', () => ({
  isSecondaryWindow: () => mocks.state.secondary,
}));
vi.mock('@/lib/toast', () => ({ toast: { info: mocks.toastInfo } }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: mocks.warn }),
}));

import { usePluginRecoveryNoticeToast } from '../usePluginRecoveryNoticeToast';

describe('usePluginRecoveryNoticeToast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.listener = undefined;
    mocks.state.secondary = false;
    mocks.consume.mockResolvedValue(null);
    mocks.subscribe.mockImplementation((listener: () => void) => {
      mocks.state.listener = listener;
      return mocks.unsubscribe;
    });
    (
      window as unknown as {
        electronAPI: {
          pluginMarket: {
            consumeRecoveryNotice: typeof mocks.consume;
            onRecoveryNoticeAvailable: typeof mocks.subscribe;
          };
        };
      }
    ).electronAPI = {
      pluginMarket: {
        consumeRecoveryNotice: mocks.consume,
        onRecoveryNoticeAvailable: mocks.subscribe,
      },
    };
  });

  afterEach(() => cleanup());

  it('subscribes before consuming and shows the cold-start recovery result', async () => {
    mocks.consume.mockResolvedValueOnce({ count: 1, name: 'GitHub' });

    const view = renderHook(() => usePluginRecoveryNoticeToast());

    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledTimes(1));
    expect(mocks.subscribe.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consume.mock.invocationCallOrder[0]!,
    );
    expect(mocks.translate).toHaveBeenCalledWith('settings.ghosts.recovery.notice.single', {
      name: 'GitHub',
    });
    expect(mocks.toastInfo).toHaveBeenCalledWith('settings.ghosts.recovery.notice.single', {
      duration: 8000,
    });

    view.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it('shows one combined notice after a later recovery signal', async () => {
    renderHook(() => usePluginRecoveryNoticeToast());
    await waitFor(() => expect(mocks.consume).toHaveBeenCalledTimes(1));
    mocks.consume.mockResolvedValueOnce({ count: 3, name: null });

    act(() => mocks.state.listener?.());

    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledTimes(1));
    expect(mocks.translate).toHaveBeenCalledWith('settings.ghosts.recovery.notice.multiple', {
      count: 3,
    });
  });

  it('does not let a secondary window consume the main-window notice', () => {
    mocks.state.secondary = true;

    renderHook(() => usePluginRecoveryNoticeToast());

    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });
});
