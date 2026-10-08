// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    success: toastSuccess,
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

const READY_STATE: DingTalkDwsStateSnapshot = {
  status: { kind: 'idle' },
  enabled: false,
  installed: true,
  identity: { corpName: 'Org', userName: 'Cindy 助手' },
  ownerName: null,
  pairingCode: null,
};

function installApi(overrides: Partial<Window['electronAPI']['dingtalkBot']> = {}) {
  let stateListener: ((update: { state: DingTalkDwsStateSnapshot }) => void) | null = null;
  const api = {
    getMode: vi.fn(async () => ({ mode: 'robot' as const })),
    setMode: vi.fn(async (mode: 'robot' | 'dws') => ({ mode })),
    getDwsState: vi.fn(async () => READY_STATE),
    connectDws: vi.fn(async () => ({
      ...READY_STATE,
      enabled: true,
      status: { kind: 'connected' as const, appId: 'dws' },
    })),
    disconnectDws: vi.fn(async () => READY_STATE),
    clearDwsOwner: vi.fn(async () => READY_STATE),
    onDwsStateChange: vi.fn((callback: (update: { state: DingTalkDwsStateSnapshot }) => void) => {
      stateListener = callback;
      return () => {
        stateListener = null;
      };
    }),
    ...overrides,
  };
  Object.assign(window, { electronAPI: { dingtalkBot: api } });
  return { api, push: (state: DingTalkDwsStateSnapshot) => stateListener?.({ state }) };
}

describe('useDingTalkDws', () => {
  beforeEach(() => {
    vi.resetModules();
    toastError.mockReset();
    toastSuccess.mockReset();
  });

  it('loads the mode and probes dws on mount', async () => {
    const { api } = installApi();
    const { useDingTalkDws } = await import('../useDingTalkDws');
    const { result } = renderHook(() => useDingTalkDws());
    await waitFor(() => expect(result.current.mode).toBe('robot'));
    await waitFor(() => expect(result.current.state.identity?.userName).toBe('Cindy 助手'));
    expect(api.getDwsState).toHaveBeenCalled();
  });

  it('switches mode through main and reprobes for the account mode', async () => {
    const { api } = installApi();
    const { useDingTalkDws } = await import('../useDingTalkDws');
    const { result } = renderHook(() => useDingTalkDws());
    await waitFor(() => expect(result.current.mode).toBe('robot'));
    await act(() => result.current.setMode('dws'));
    expect(api.setMode).toHaveBeenCalledWith('dws');
    expect(result.current.mode).toBe('dws');
  });

  it('maps connect failures to specific toasts', async () => {
    installApi({
      connectDws: vi.fn(async () => {
        throw new Error('[DINGTALK_DWS_NOT_LOGGED_IN] DINGTALK_DWS_NOT_LOGGED_IN');
      }),
    });
    const { useDingTalkDws } = await import('../useDingTalkDws');
    const { result } = renderHook(() => useDingTalkDws());
    await act(() => result.current.connect());
    expect(toastError).toHaveBeenCalledWith('logic.toasts.dingtalkDwsNotLoggedIn');
  });

  it('applies connected state and pushed updates', async () => {
    const { push } = installApi();
    const { useDingTalkDws } = await import('../useDingTalkDws');
    const { result } = renderHook(() => useDingTalkDws());
    await act(() => result.current.connect());
    expect(result.current.state.status.kind).toBe('connected');
    expect(toastSuccess).toHaveBeenCalledWith('logic.toasts.dingtalkDwsConnected');
    act(() =>
      push({
        ...READY_STATE,
        enabled: true,
        ownerName: '张三',
        status: { kind: 'connected', appId: 'dws' },
      }),
    );
    expect(result.current.state.ownerName).toBe('张三');
  });
});
