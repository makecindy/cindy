// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: toastError,
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

type DingTalkState = {
  appKey: string | null;
  hasSecret: boolean;
  ownerUserId: string | null;
  status: DingTalkBotTransportStatus;
};

function installDingTalkApi() {
  const initialState: DingTalkState = {
    appKey: null,
    hasSecret: false,
    ownerUserId: null,
    status: { kind: 'idle' },
  };
  const api = {
    getState: vi.fn(async () => initialState),
    save: vi.fn(async () => initialState),
    reconnect: vi.fn(async () => initialState),
    clear: vi.fn(async () => ({ ok: true as const })),
    onStatusChange: vi.fn(() => () => {}),
    onOwnerChange: vi.fn(() => () => {}),
  };
  (window as unknown as { electronAPI: { dingtalkBot: typeof api } }).electronAPI = {
    dingtalkBot: api,
  };
  return api;
}

let useDingTalkBot: typeof import('../useDingTalkBot').useDingTalkBot;

describe('useDingTalkBot', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    ({ useDingTalkBot } = await import('../useDingTalkBot'));
  });

  it('preserves the credential draft and shows the Stream-specific error after a failed save', async () => {
    const api = installDingTalkApi();
    api.save.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'dingtalkBot:save': Error: " +
          '[DINGTALK_STREAM_CONNECTION_FAILED] DINGTALK_STREAM_CONNECTION_FAILED',
      ),
    );
    const { result } = renderHook(() => useDingTalkBot());

    await waitFor(() => expect(api.getState).toHaveBeenCalledOnce());
    act(() => {
      result.current.setAppKey('test-client-id');
      result.current.setAppSecret('test-client-secret');
    });

    await act(async () => {
      await expect(result.current.connect()).resolves.toBe(false);
    });

    expect(result.current.appKey).toBe('test-client-id');
    expect(result.current.appSecret).toBe('test-client-secret');
    expect(api.getState).toHaveBeenCalledOnce();
    expect(toastError).toHaveBeenCalledWith('logic.toasts.dingtalkBotStreamFailed');
  });
});
