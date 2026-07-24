// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

type RegistrationListener = (payload: {
  status: 'success';
  appId: string;
  ownerOpenId: string;
}) => void;

type FeishuState = {
  status: FeishuBotStatus;
  appId: string | null;
  appSecret: string | null;
  hasSecret: boolean;
  ownerOpenId: string | null;
  lifecycleAnnouncement: boolean;
};

function installFeishuApi() {
  const statusListeners = new Set<StatusListener>();
  const registrationListeners = new Set<RegistrationListener>();
  const api = {
    getState: vi.fn(async (): Promise<FeishuState> => ({
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
    onRegistrationStatus: vi.fn((listener: RegistrationListener) => {
      registrationListeners.add(listener);
      return () => registrationListeners.delete(listener);
    }),
  };
  (window as unknown as { electronAPI: { feishuBot: typeof api } }).electronAPI = {
    feishuBot: api,
  };
  return { api, statusListeners, registrationListeners };
}

let useFeishuBot: typeof import('../useFeishuBot').useFeishuBot;

describe('useFeishuBot', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    ({ useFeishuBot } = await import('../useFeishuBot'));
  });

  it('updates the live owner and module cache when main claims the first sender', async () => {
    const { api, statusListeners } = installFeishuApi();
    api.getState.mockResolvedValueOnce({
      status: 'connected',
      appId: 'cli_hydrated_owner_test',
      appSecret: null,
      hasSecret: true,
      ownerOpenId: null,
      lifecycleAnnouncement: true,
    });
    const first = renderHook(() => useFeishuBot());

    await waitFor(() => expect(first.result.current.appId).toBe('cli_hydrated_owner_test'));
    expect(first.result.current.ownerOpenId).toBeNull();

    act(() => {
      for (const listener of statusListeners) {
        listener({
          status: 'connected',
          botAppId: 'cli_hydrated_owner_test',
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

  it('does not let an older getState response overwrite a newer owner push', async () => {
    let resolveState!: (state: {
      status: 'connected';
      appId: string;
      appSecret: null;
      hasSecret: true;
      ownerOpenId: null;
      lifecycleAnnouncement: true;
    }) => void;
    const staleState = new Promise<Parameters<typeof resolveState>[0]>((resolve) => {
      resolveState = resolve;
    });
    const { api, statusListeners } = installFeishuApi();
    api.getState.mockReturnValueOnce(staleState);

    const hook = renderHook(() => useFeishuBot());
    await waitFor(() => expect(statusListeners.size).toBe(1));

    act(() => {
      for (const listener of statusListeners) {
        listener({
          status: 'connected',
          botAppId: 'cli_test',
          ownerOpenId: 'ou_race_owner',
        });
      }
    });

    resolveState({
      status: 'connected',
      appId: 'cli_test',
      appSecret: null,
      hasSecret: true,
      ownerOpenId: null,
      lifecycleAnnouncement: true,
    });

    expect(api.getState).toHaveBeenCalledOnce();
    await waitFor(() => expect(hook.result.current.ownerOpenId).toBe('ou_race_owner'));
  });

  it('subscribes before the initial state read so a synchronous push is not lost', async () => {
    const { api, statusListeners } = installFeishuApi();
    api.getState.mockImplementationOnce(async () => {
      for (const listener of statusListeners) {
        listener({
          status: 'connected',
          botAppId: 'cli_test',
          ownerOpenId: 'ou_mount_race_owner',
        });
      }
      return {
        status: 'connected',
        appId: 'cli_test',
        appSecret: null,
        hasSecret: true,
        ownerOpenId: null,
        lifecycleAnnouncement: true,
      };
    });

    const hook = renderHook(() => useFeishuBot());

    await waitFor(() =>
      expect(hook.result.current.ownerOpenId).toBe('ou_mount_race_owner'),
    );
  });

  it('does not let an older reload overwrite a newer registration reload', async () => {
    type State = Awaited<ReturnType<ReturnType<typeof installFeishuApi>['api']['getState']>>;
    let resolveOlder!: (state: State) => void;
    let resolveNewer!: (state: State) => void;
    const olderState = new Promise<State>((resolve) => {
      resolveOlder = resolve;
    });
    const newerState = new Promise<State>((resolve) => {
      resolveNewer = resolve;
    });
    const { api, registrationListeners } = installFeishuApi();
    api.getState.mockReturnValueOnce(olderState).mockReturnValueOnce(newerState);

    const hook = renderHook(() => useFeishuBot());
    await waitFor(() => expect(api.getState).toHaveBeenCalledOnce());

    act(() => {
      for (const listener of registrationListeners) {
        listener({
          status: 'success',
          appId: 'cli_registered',
          ownerOpenId: 'ou_registered_owner',
        });
      }
    });
    await waitFor(() => expect(api.getState).toHaveBeenCalledTimes(2));

    resolveNewer({
      status: 'connected',
      appId: 'cli_registered',
      appSecret: null,
      hasSecret: true,
      ownerOpenId: 'ou_registered_owner',
      lifecycleAnnouncement: true,
    });
    await waitFor(() => expect(hook.result.current.ownerOpenId).toBe('ou_registered_owner'));

    resolveOlder({
      status: 'connected',
      appId: 'cli_stale',
      appSecret: null,
      hasSecret: true,
      ownerOpenId: null,
      lifecycleAnnouncement: true,
    });
    await act(async () => {
      await olderState;
    });

    expect(hook.result.current.appId).toBe('cli_registered');
    expect(hook.result.current.ownerOpenId).toBe('ou_registered_owner');
  });
});
