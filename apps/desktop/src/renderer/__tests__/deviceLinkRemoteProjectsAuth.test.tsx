// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  isAuthenticated: false,
  deviceId: 'self-device',
  dataOwnerId: 'local-v1' as string | null,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

import { useDeviceLinkRemoteProjects } from '@/features/device-link/useDeviceLinkRemoteProjects';

const getSessionList = vi.fn(async () => {
  throw new Error('[PERMISSION_DENIED] Device Link requires a Cindy account.');
});

beforeEach(() => {
  vi.useFakeTimers();
  authState.isAuthenticated = false;
  authState.deviceId = 'self-device';
  authState.dataOwnerId = 'local-v1';
  getSessionList.mockClear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      deviceLink: {
        mirrorCache: { getSessionList },
      },
    } as unknown as Window['electronAPI'],
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'electronAPI');
  vi.useRealTimers();
});

describe('Device Link remote projects auth gate', () => {
  it('跳过登录进入 local mode 时不启动 session-list owner token 补读', async () => {
    const { unmount } = renderHook(() => useDeviceLinkRemoteProjects());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(getSessionList).not.toHaveBeenCalled();
    unmount();
  });
});
