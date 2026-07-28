// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isChatGptConnectionConnected, useCodexAuth } from '../useCodexAuth';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

type TestAuthState = {
  authenticated: boolean;
  identity?: string;
  errorReason?: string;
  authSource?: 'oauth' | 'api-key';
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installAuthApi(logout: () => Promise<void>) {
  const auth = {
    getState: vi.fn(async (): Promise<TestAuthState> => ({
      authenticated: true,
      identity: 'user@example.com',
      authSource: 'oauth' as const,
    })),
    triggerLogin: vi.fn(),
    cancelLogin: vi.fn(async () => undefined),
    logout: vi.fn(logout),
    onStateChanged: vi.fn(() => () => undefined),
    onLoginProgress: vi.fn(() => () => undefined),
  };
  (window as unknown as { electronAPI: { maker: { auth: typeof auth } } }).electronAPI = {
    maker: { auth },
  };
  return auth;
}

function stateChangedListener(auth: ReturnType<typeof installAuthApi>) {
  const calls = auth.onStateChanged.mock.calls as unknown as Array<
    [(payload: { agentKind: string; authenticated: boolean; errorReason?: string }) => void]
  >;
  return calls[0][0];
}

function loginProgressListener(auth: ReturnType<typeof installAuthApi>) {
  const calls = auth.onLoginProgress.mock.calls as unknown as Array<
    [(
      payload: {
        agentKind: string;
        phase: string;
        mode?: 'browser' | 'device-code';
        detail?: string;
        verificationUrl?: string;
        userCode?: string;
      },
    ) => void]
  >;
  return calls[0][0];
}

describe('useCodexAuth lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('keeps the authenticated UI when durable disconnect was not committed', async () => {
    const auth = installAuthApi(async () => {
      throw new Error('[INTERNAL] failed to persist Codex disconnect state');
    });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    await act(async () => {
      await expect(result.current.logout()).rejects.toThrow('failed to persist');
    });

    expect(auth.logout).toHaveBeenCalledWith('codex');
    expect(result.current.state.kind).toBe('authenticated');
  });

  it('switches to unauthenticated only after main confirms logout', async () => {
    installAuthApi(async () => undefined);
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.state.kind).toBe('unauthenticated');
  });

  it('refreshes to disconnected when cleanup fails after the marker committed', async () => {
    const auth = installAuthApi(async () => {
      throw new Error('[INTERNAL] failed to remove Codex auth file');
    });
    auth.getState
      .mockResolvedValueOnce({
        authenticated: true,
        identity: 'user@example.com',
        authSource: 'oauth' as const,
      })
      .mockResolvedValueOnce({ authenticated: false, identity: '', authSource: 'oauth' as const });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    await act(async () => {
      await expect(result.current.logout()).rejects.toThrow('failed to remove');
    });

    expect(result.current.state.kind).toBe('unauthenticated');
  });

  it('reconciles and surfaces a failed durable cancellation instead of claiming disconnect', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.cancelLogin.mockRejectedValue(
      new Error('[INTERNAL] failed to persist Codex disconnect state'),
    );
    auth.getState
      .mockResolvedValueOnce({
        authenticated: true,
        identity: 'user@example.com',
        authSource: 'oauth' as const,
      })
      .mockResolvedValueOnce({
        authenticated: true,
        identity: 'user@example.com',
        authSource: 'oauth' as const,
      });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    await act(async () => {
      await result.current.cancelLogin();
    });

    expect(auth.cancelLogin).toHaveBeenCalledWith('codex');
    expect(auth.getState).toHaveBeenCalledTimes(2);
    expect(result.current.state).toEqual({
      kind: 'authenticated',
      identity: 'user@example.com',
      expiresAt: undefined,
      authSource: 'oauth',
    });
  });

  it('returns failed while retaining a generic main-process login reason', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.triggerLogin.mockResolvedValue({ authenticated: false, errorReason: 'login_timeout' });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    await act(async () => {
      await expect(result.current.triggerLogin()).resolves.toBe('failed');
    });

    expect(result.current.state).toEqual({ kind: 'error', message: 'login_timeout' });
  });

  it('restores reconnect-required from a persisted OAuth invalidation', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.getState.mockResolvedValueOnce({
      authenticated: false,
      errorReason: 'refresh_token_reused',
      authSource: 'oauth' as const,
    });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => {
      expect(result.current.state).toEqual({
        kind: 'reconnect-required',
        reason: 'refresh_token_reused',
      });
    });
  });

  it('enters reconnect-required immediately after an invalidation broadcast', async () => {
    const auth = installAuthApi(async () => undefined);
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    act(() => {
      stateChangedListener(auth)({
        agentKind: 'codex',
        authenticated: false,
        errorReason: 'token_revoked',
      });
    });

    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
    });
  });

  it('does not let an older initial snapshot overwrite a newer invalidation broadcast', async () => {
    const auth = installAuthApi(async () => undefined);
    const initialState = deferred<TestAuthState>();
    auth.getState.mockImplementationOnce(() => initialState.promise);
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(auth.onStateChanged).toHaveBeenCalledOnce());
    act(() => {
      stateChangedListener(auth)({
        agentKind: 'codex',
        authenticated: false,
        errorReason: 'token_revoked',
      });
    });

    await act(async () => {
      initialState.resolve({
        authenticated: true,
        identity: 'stale@example.com',
        authSource: 'oauth',
      });
      await initialState.promise;
    });

    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
    });
  });

  it('keeps login-pending continuous while the initial snapshot records a reconnect reason', async () => {
    const auth = installAuthApi(async () => undefined);
    const initialState = deferred<TestAuthState>();
    auth.getState.mockImplementationOnce(() => initialState.promise);
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(auth.onLoginProgress).toHaveBeenCalledOnce());
    act(() => {
      loginProgressListener(auth)({ agentKind: 'codex', phase: 'login-pending' });
    });
    expect(result.current.state).toEqual({ kind: 'login-pending', mode: 'browser' });

    await act(async () => {
      initialState.resolve({
        authenticated: false,
        errorReason: 'token_revoked',
        authSource: 'oauth',
      });
      await initialState.promise;
    });

    expect(result.current.state).toEqual({ kind: 'login-pending', mode: 'browser' });

    act(() => {
      stateChangedListener(auth)({
        agentKind: 'codex',
        authenticated: false,
        errorReason: 'login_timeout',
      });
    });
    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
    });
  });

  it('restores reconnect-required when that progress-first login is cancelled', async () => {
    const auth = installAuthApi(async () => undefined);
    const initialState = deferred<TestAuthState>();
    auth.getState.mockImplementationOnce(() => initialState.promise);
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(auth.onLoginProgress).toHaveBeenCalledOnce());
    act(() => {
      loginProgressListener(auth)({ agentKind: 'codex', phase: 'login-pending' });
    });
    await act(async () => {
      initialState.resolve({
        authenticated: false,
        errorReason: 'refresh_token_reused',
        authSource: 'oauth',
      });
      await initialState.promise;
    });
    await act(async () => {
      await result.current.cancelLogin();
    });

    expect(auth.cancelLogin).toHaveBeenCalledWith('codex');
    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'refresh_token_reused',
    });
  });

  it('coalesces login requests across separate UI hook instances', async () => {
    const auth = installAuthApi(async () => undefined);
    const login = deferred<TestAuthState>();
    auth.triggerLogin.mockImplementation(() => login.promise);
    const first = renderHook(() => useCodexAuth());
    const second = renderHook(() => useCodexAuth());

    await waitFor(() => expect(first.result.current.state.kind).toBe('authenticated'));
    await waitFor(() => expect(second.result.current.state.kind).toBe('authenticated'));

    let firstOutcome!: ReturnType<typeof first.result.current.triggerLogin>;
    let secondOutcome!: ReturnType<typeof second.result.current.triggerLogin>;
    act(() => {
      firstOutcome = first.result.current.triggerLogin();
      secondOutcome = second.result.current.triggerLogin();
    });
    await waitFor(() => expect(auth.triggerLogin).toHaveBeenCalledOnce());

    login.resolve({ authenticated: true, authSource: 'oauth' });
    await act(async () => {
      await expect(firstOutcome).resolves.toBe('authenticated');
      await expect(secondOutcome).resolves.toBe('authenticated');
    });
    expect(auth.triggerLogin).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ ownerId: expect.any(String) }),
    );
  });

  it('keeps a shared owned login until the last owner unmounts and ignores observers', async () => {
    const auth = installAuthApi(async () => undefined);
    const login = deferred<TestAuthState>();
    auth.triggerLogin.mockImplementation(() => login.promise);
    const firstOwner = renderHook(() => useCodexAuth());
    const secondOwner = renderHook(() => useCodexAuth());
    const observer = renderHook(() => useCodexAuth());

    await waitFor(() => expect(firstOwner.result.current.state.kind).toBe('authenticated'));
    await waitFor(() => expect(secondOwner.result.current.state.kind).toBe('authenticated'));
    await waitFor(() => expect(observer.result.current.state.kind).toBe('authenticated'));

    let firstOutcome!: ReturnType<typeof firstOwner.result.current.triggerLogin>;
    let secondOutcome!: ReturnType<typeof secondOwner.result.current.triggerLogin>;
    act(() => {
      firstOutcome = firstOwner.result.current.triggerLogin('device-code');
      secondOutcome = secondOwner.result.current.triggerLogin('device-code');
    });
    await waitFor(() =>
      expect(auth.triggerLogin).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ mode: 'device-code', ownerId: expect.any(String) }),
      ),
    );
    expect(auth.triggerLogin).toHaveBeenCalledOnce();

    observer.unmount();
    firstOwner.unmount();
    expect(auth.cancelLogin).not.toHaveBeenCalled();

    secondOwner.unmount();
    expect(auth.cancelLogin).toHaveBeenCalledOnce();
    expect(auth.cancelLogin).toHaveBeenCalledWith('codex', {
      releaseOwner: true,
      ownerId: expect.any(String),
    });

    // 即使 bridge 取消失败、main 最终回了成功，已卸载 owner 也只能观察到 cancelled，
    // 不能在关闭向导后迟到弹出“连接成功”或更新卸载组件。
    login.resolve({ authenticated: true, authSource: 'oauth' });
    await act(async () => {
      await expect(firstOutcome).resolves.toBe('cancelled');
      await expect(secondOutcome).resolves.toBe('cancelled');
    });
  });

  it('does not start a login through a retained callback after its owner unmounts', async () => {
    const auth = installAuthApi(async () => undefined);
    const owner = renderHook(() => useCodexAuth());
    await waitFor(() => expect(owner.result.current.state.kind).toBe('authenticated'));
    const triggerAfterUnmount = owner.result.current.triggerLogin;

    owner.unmount();
    await expect(triggerAfterUnmount('device-code')).resolves.toBe('cancelled');

    expect(auth.triggerLogin).not.toHaveBeenCalled();
    expect(auth.cancelLogin).not.toHaveBeenCalled();
  });

  it('keeps the device code visible while later waiting output arrives', async () => {
    const auth = installAuthApi(async () => undefined);
    const login = deferred<TestAuthState>();
    auth.triggerLogin.mockImplementation(() => login.promise);
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    let attempt!: Promise<string>;
    act(() => {
      attempt = result.current.triggerLogin('device-code');
    });
    await waitFor(() =>
      expect(auth.triggerLogin).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ mode: 'device-code', ownerId: expect.any(String) }),
      ),
    );

    act(() => {
      loginProgressListener(auth)({
        agentKind: 'codex',
        phase: 'device-code',
        mode: 'device-code',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'RUH2-7E2VH',
      });
      loginProgressListener(auth)({
        agentKind: 'codex',
        phase: 'login-pending',
        mode: 'device-code',
        detail: 'Waiting for authorization',
      });
    });

    expect(result.current.state).toEqual({
      kind: 'login-pending',
      mode: 'device-code',
      deviceCode: {
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'RUH2-7E2VH',
      },
    });

    login.resolve({ authenticated: false, errorReason: 'login_cancelled' });
    await act(async () => {
      await expect(attempt).resolves.toBe('cancelled');
    });
  });

  it('does not treat a Cindy AI API key as a connected ChatGPT account', () => {
    expect(
      isChatGptConnectionConnected(
        {
          kind: 'authenticated',
          identity: 'API Key · Cindy AI',
          authSource: 'api-key',
        },
        true,
      ),
    ).toBe(false);
    expect(
      isChatGptConnectionConnected(
        {
          kind: 'authenticated',
          identity: 'user@example.com',
          authSource: 'oauth',
        },
        false,
      ),
    ).toBe(true);
    expect(isChatGptConnectionConnected({ kind: 'loading' }, true)).toBe(true);
  });

  it('keeps OAuth invalidation distinct from a generic login failure', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.triggerLogin.mockResolvedValue({
      authenticated: false,
      errorReason: 'token_invalidated',
    });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    await act(async () => {
      await expect(result.current.triggerLogin()).resolves.toBe('failed');
    });

    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_invalidated',
    });
  });

  it('treats user cancellation as a non-error outcome for first-time connection', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.getState.mockResolvedValueOnce({ authenticated: false });
    auth.triggerLogin.mockResolvedValue({ authenticated: false, errorReason: 'login_cancelled' });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('unauthenticated'));
    await act(async () => {
      await expect(result.current.triggerLogin()).resolves.toBe('cancelled');
    });

    expect(result.current.state).toEqual({ kind: 'unauthenticated' });
  });

  it('does not flash an error when first-time cancellation arrives as a broadcast', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.getState.mockResolvedValueOnce({ authenticated: false });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('unauthenticated'));
    act(() => {
      stateChangedListener(auth)({
        agentKind: 'codex',
        authenticated: false,
        errorReason: 'login_cancelled',
      });
    });

    expect(result.current.state).toEqual({ kind: 'unauthenticated' });
  });

  it('lets an observer-only window leave login-pending when main broadcasts cancellation', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.getState.mockResolvedValueOnce({ authenticated: false });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('unauthenticated'));
    act(() => {
      loginProgressListener(auth)({ agentKind: 'codex', phase: 'login-pending' });
    });
    expect(result.current.state).toEqual({ kind: 'login-pending', mode: 'browser' });

    act(() => {
      stateChangedListener(auth)({
        agentKind: 'codex',
        authenticated: false,
        errorReason: 'login_cancelled',
      });
    });
    expect(result.current.state).toEqual({ kind: 'unauthenticated' });
  });

  it('keeps reconnect-required after a reconnection attempt is cancelled', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.getState.mockResolvedValueOnce({
      authenticated: false,
      errorReason: 'token_revoked',
      authSource: 'oauth' as const,
    });
    auth.triggerLogin.mockResolvedValue({ authenticated: false, errorReason: 'login_cancelled' });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('reconnect-required'));
    await act(async () => {
      await expect(result.current.triggerLogin()).resolves.toBe('cancelled');
    });

    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
    });
  });

  it('keeps reconnect-required when an observer only receives a failed login broadcast', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.getState.mockResolvedValueOnce({
      authenticated: false,
      errorReason: 'refresh_token_reused',
      authSource: 'oauth' as const,
    });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('reconnect-required'));
    act(() => {
      stateChangedListener(auth)({
        agentKind: 'codex',
        authenticated: false,
        errorReason: 'login_timeout',
      });
    });

    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'refresh_token_reused',
    });
  });
});
