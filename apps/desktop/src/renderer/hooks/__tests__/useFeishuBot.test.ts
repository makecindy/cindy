// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFeishuBot } from '../useFeishuBot';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars?.message ? `${key}:${vars.message}` : key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

type StatusListener = (payload: {
  status: FeishuBotStatus;
  error?: string;
  botAppId: string | null;
  ownerOpenId: string | null;
}) => void;

function installFeishuApi() {
  const statusListeners = new Set<StatusListener>();
  const api = {
    getState: vi.fn(async () => ({
      status: 'connected' as const,
      appId: 'cli_test',
      appSecret: null,
      hasSecret: true,
      ownerOpenId: null,
      lifecycleAnnouncement: true,
    })),
    save: vi.fn(),
    reconnect: vi.fn(),
    clear: vi.fn(),
    setLifecycleAnnouncement: vi.fn(),
    registrationBegin: vi.fn(),
    registrationCancel: vi.fn(),
    onStatusChange: vi.fn((listener: StatusListener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    }),
    onConflict: vi.fn(() => () => {}),
    onRegistrationStatus: vi.fn(() => () => {}),
  };
  (window as unknown as { electronAPI: { feishuBot: typeof api } }).electronAPI = {
    feishuBot: api,
  };
  return { api, statusListeners };
}

describe('useFeishuBot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('updates the live owner and module cache when main claims the first sender', async () => {
    const { api, statusListeners } = installFeishuApi();
    const first = renderHook(() => useFeishuBot());

    await waitFor(() => expect(first.result.current.status).toBe('connected'));
    expect(first.result.current.ownerOpenId).toBeNull();

    act(() => {
      for (const listener of statusListeners) {
        listener({
          status: 'connected',
          botAppId: 'cli_test',
          ownerOpenId: 'ou_new_owner',
        });
      }
    });

    expect(first.result.current.ownerOpenId).toBe('ou_new_owner');
    first.unmount();

    api.getState.mockImplementationOnce(() => new Promise(() => {}));
    const second = renderHook(() => useFeishuBot());
    expect(second.result.current.ownerOpenId).toBe('ou_new_owner');
  });
});
