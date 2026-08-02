// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isChatGptConnectionConnected, useCodexAuth } from '../useCodexAuth';
import { acquireCodexLogin } from '../codexAuthLogin';

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
  credentialScope?: 'system-shared' | 'instance-isolated' | 'unknown';
  recoveryRequiredReason?: string;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installAuthApi(logout: () => Promise<void>) {
  const getCodexRateLimits = vi.fn(async () => ({ rateLimits: null, resetOffer: null }));
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
    getCodexRateLimits,
  };
  (
    window as unknown as {
      electronAPI: {
        maker: { auth: typeof auth; usage: { getCodexRateLimits: typeof getCodexRateLimits } };
      };
    }
  ).electronAPI = {
    maker: { auth, usage: { getCodexRateLimits } },
  };
  return auth;
}

function stateChangedListener(auth: ReturnType<typeof installAuthApi>) {
  const calls = auth.onStateChanged.mock.calls as unknown as Array<
    [
      (payload: {
        agentKind: string;
        authenticated: boolean;
        errorReason?: string;
        credentialScope?: 'system-shared' | 'instance-isolated' | 'unknown';
        recoveryRequiredReason?: string;
      }) => void,
    ]
  >;
  return calls[0][0];
}

function loginProgressListener(auth: ReturnType<typeof installAuthApi>) {
  const calls = auth.onLoginProgress.mock.calls as unknown as Array<
    [
      (payload: {
        agentKind: string;
        phase: string;
        mode?: 'browser' | 'device-code';
        detail?: string;
        verificationUrl?: string;
        userCode?: string;
      }) => void,
    ]
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
      credentialScope: 'system-shared' as const,
    });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => {
      expect(result.current.state).toEqual({
        kind: 'reconnect-required',
        reason: 'refresh_token_reused',
        credentialScope: 'system-shared',
      });
    });
  });

  it('verifies a fresh-mount authenticated recovery candidate before exposing connected', async () => {
    const auth = installAuthApi(async () => undefined);
    const verification = deferred<{ rateLimits: null; resetOffer: null }>();
    auth.getState
      .mockResolvedValueOnce({
        authenticated: true,
        identity: 'user@example.com',
        authSource: 'oauth',
        credentialScope: 'system-shared',
        recoveryRequiredReason: 'token_revoked',
      })
      .mockResolvedValueOnce({
        authenticated: true,
        identity: 'user@example.com',
        authSource: 'oauth',
        credentialScope: 'system-shared',
      });
    auth.getCodexRateLimits.mockImplementationOnce(() => verification.promise);
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(auth.getCodexRateLimits).toHaveBeenCalledOnce());
    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
      credentialScope: 'system-shared',
    });
    expect(result.current.recoveryCheck).toBe('checking');

    await act(async () => {
      verification.resolve({ rateLimits: null, resetOffer: null });
      await verification.promise;
    });
    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
  });

  it('keeps recovery pending when the account probe succeeds but main has not committed it', async () => {
    const auth = installAuthApi(async () => undefined);
    const pendingRecovery = {
      authenticated: true,
      identity: 'user@example.com',
      authSource: 'oauth' as const,
      credentialScope: 'system-shared' as const,
      recoveryRequiredReason: 'token_revoked',
    };
    auth.getState.mockResolvedValue(pendingRecovery);
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.recoveryCheck).toBe('failed'));
    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
      credentialScope: 'system-shared',
    });
    expect(auth.getCodexRateLimits).toHaveBeenCalledOnce();
    expect(auth.getState).toHaveBeenCalledTimes(2);
  });

  it('keeps a hinted recovery loading until the authoritative snapshot is known', async () => {
    const auth = installAuthApi(async () => undefined);
    const initialState = deferred<TestAuthState>();
    const verification = deferred<{ rateLimits: null; resetOffer: null }>();
    auth.getState.mockImplementationOnce(() => initialState.promise);
    auth.getCodexRateLimits.mockImplementationOnce(() => verification.promise);
    const { result } = renderHook(() =>
      useCodexAuth({ recoveryHint: { reason: 'token_revoked' } }),
    );

    expect(result.current.state).toEqual({ kind: 'loading' });
    expect(result.current.recoveryCheck).toBe('idle');

    await act(async () => {
      initialState.resolve({
        authenticated: true,
        identity: 'user@example.com',
        authSource: 'oauth',
        credentialScope: 'system-shared',
      });
      await initialState.promise;
    });
    await waitFor(() => expect(auth.getCodexRateLimits).toHaveBeenCalledOnce());
    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
      credentialScope: 'system-shared',
    });
    expect(result.current.recoveryCheck).toBe('checking');

    await act(async () => {
      verification.resolve({ rateLimits: null, resetOffer: null });
      await verification.promise;
    });
    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
  });

  it('shares one credential probe across observers with different recovery hints', async () => {
    const auth = installAuthApi(async () => undefined);
    const verification = deferred<{ rateLimits: null; resetOffer: null }>();
    auth.getState.mockResolvedValue({
      authenticated: true,
      identity: 'user@example.com',
      authSource: 'oauth',
      credentialScope: 'system-shared',
    });
    auth.getCodexRateLimits.mockImplementation(() => verification.promise);
    const { result } = renderHook(() => ({
      first: useCodexAuth({ recoveryHint: { reason: 'token_revoked' } }),
      second: useCodexAuth({ recoveryHint: { reason: 'refresh_token_reused' } }),
    }));

    await waitFor(() => {
      expect(result.current.first.recoveryCheck).toBe('checking');
      expect(result.current.second.recoveryCheck).toBe('checking');
    });
    expect(auth.getCodexRateLimits).toHaveBeenCalledOnce();

    await act(async () => {
      verification.resolve({ rateLimits: null, resetOffer: null });
      await verification.promise;
    });

    await waitFor(() => {
      expect(result.current.first.state.kind).toBe('authenticated');
      expect(result.current.second.state.kind).toBe('authenticated');
    });
    expect(auth.getCodexRateLimits).toHaveBeenCalledOnce();
  });

  it('keeps a fresh-mount recovery candidate actionable when its account probe fails', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.getState.mockResolvedValue({
      authenticated: true,
      identity: 'user@example.com',
      authSource: 'oauth',
      credentialScope: 'instance-isolated',
      recoveryRequiredReason: 'token_revoked',
    });
    auth.getCodexRateLimits.mockRejectedValueOnce(new Error('network unavailable'));
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.recoveryCheck).toBe('failed'));
    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
  });

  it('refreshes on window focus and exposes authenticated only after a server probe', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.getState
      .mockResolvedValueOnce({
        authenticated: false,
        errorReason: 'token_revoked',
        credentialScope: 'system-shared',
      })
      .mockResolvedValue({
        authenticated: true,
        identity: 'user@example.com',
        authSource: 'oauth',
        credentialScope: 'system-shared',
      });
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('reconnect-required'));
    act(() => window.dispatchEvent(new Event('focus')));

    await waitFor(() => expect(auth.getCodexRateLimits).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.state.kind).toBe('authenticated'));
    expect(result.current.recoveryCheck).toBe('idle');
  });

  it('keeps reconnect-required and offers a manual recheck when verification is unavailable', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.getState
      .mockResolvedValueOnce({
        authenticated: false,
        errorReason: 'token_revoked',
        credentialScope: 'instance-isolated',
      })
      .mockResolvedValue({
        authenticated: true,
        identity: 'user@example.com',
        authSource: 'oauth',
        credentialScope: 'instance-isolated',
      });
    auth.getCodexRateLimits.mockRejectedValueOnce(new Error('network unavailable'));
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('reconnect-required'));
    act(() => window.dispatchEvent(new Event('focus')));

    await waitFor(() => expect(result.current.recoveryCheck).toBe('failed'));
    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.state.kind).toBe('authenticated');
    expect(result.current.recoveryCheck).toBe('idle');
  });

  it('leaves login-pending and restores recheck after a successful OAuth result cannot be verified', async () => {
    const auth = installAuthApi(async () => undefined);
    auth.getState.mockResolvedValueOnce({
      authenticated: false,
      errorReason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
    auth.triggerLogin.mockResolvedValue({
      authenticated: true,
      identity: 'user@example.com',
      authSource: 'oauth',
      credentialScope: 'instance-isolated',
    });
    auth.getCodexRateLimits.mockRejectedValueOnce(new Error('network unavailable'));
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('reconnect-required'));
    await act(async () => {
      await expect(result.current.triggerLogin()).resolves.toBe('unverified');
    });

    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
    expect(result.current.recoveryCheck).toBe('failed');
  });

  it('ignores a recovery probe that settles after the observer is disabled and re-enabled', async () => {
    const auth = installAuthApi(async () => undefined);
    const verification = deferred<{ rateLimits: null; resetOffer: null }>();
    auth.getState
      .mockResolvedValueOnce({
        authenticated: false,
        errorReason: 'token_revoked',
        credentialScope: 'system-shared',
      })
      .mockResolvedValueOnce({
        authenticated: true,
        identity: 'stale@example.com',
        authSource: 'oauth',
        credentialScope: 'system-shared',
      })
      .mockResolvedValueOnce({
        authenticated: false,
        errorReason: 'token_revoked',
        credentialScope: 'system-shared',
      });
    auth.getCodexRateLimits.mockImplementationOnce(() => verification.promise);
    const hook = renderHook(({ enabled }) => useCodexAuth({ enabled }), {
      initialProps: { enabled: true },
    });

    await waitFor(() => expect(hook.result.current.state.kind).toBe('reconnect-required'));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(auth.getCodexRateLimits).toHaveBeenCalledOnce());

    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    await waitFor(() => expect(auth.getState).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(hook.result.current.state).toEqual({
        kind: 'reconnect-required',
        reason: 'token_revoked',
        credentialScope: 'system-shared',
      }),
    );

    await act(async () => {
      verification.resolve({ rateLimits: null, resetOffer: null });
      await verification.promise;
    });
    expect(hook.result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
      credentialScope: 'system-shared',
    });
  });

  it('settles the current recovery check when another login makes its probe stale', async () => {
    const auth = installAuthApi(async () => undefined);
    const verification = deferred<{ rateLimits: null; resetOffer: null }>();
    const login = deferred<TestAuthState>();
    auth.getState
      .mockResolvedValueOnce({
        authenticated: false,
        errorReason: 'token_revoked',
        credentialScope: 'system-shared',
      })
      .mockResolvedValueOnce({
        authenticated: true,
        identity: 'candidate@example.com',
        authSource: 'oauth',
        credentialScope: 'system-shared',
      });
    auth.getCodexRateLimits.mockImplementationOnce(() => verification.promise);
    auth.triggerLogin.mockImplementationOnce(() => login.promise);
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('reconnect-required'));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(result.current.recoveryCheck).toBe('checking'));

    const lease = acquireCodexLogin();
    await waitFor(() => expect(auth.triggerLogin).toHaveBeenCalledOnce());
    await act(async () => {
      verification.resolve({ rateLimits: null, resetOffer: null });
      await verification.promise;
    });
    await waitFor(() => expect(result.current.recoveryCheck).toBe('idle'));
    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
      credentialScope: 'system-shared',
    });

    login.resolve({ authenticated: false, errorReason: 'login_cancelled' });
    await lease.promise;
    lease.release();
  });

  it('does not reuse a prior credential probe after same-reason invalidation and relogin', async () => {
    const auth = installAuthApi(async () => undefined);
    const firstProbe = deferred<{ rateLimits: null; resetOffer: null }>();
    const secondProbe = deferred<{ rateLimits: null; resetOffer: null }>();
    auth.getState
      .mockResolvedValueOnce({
        authenticated: false,
        errorReason: 'token_revoked',
        credentialScope: 'instance-isolated',
      })
      .mockResolvedValueOnce({
        authenticated: true,
        identity: 'old@example.com',
        authSource: 'oauth',
        credentialScope: 'instance-isolated',
      });
    auth.getCodexRateLimits
      .mockImplementationOnce(() => firstProbe.promise)
      .mockImplementationOnce(() => secondProbe.promise);
    const loginResult = {
      authenticated: true,
      identity: 'new@example.com',
      authSource: 'oauth' as const,
      credentialScope: 'instance-isolated' as const,
    };
    auth.triggerLogin.mockResolvedValue(loginResult);
    const { result } = renderHook(() => useCodexAuth());

    await waitFor(() => expect(result.current.state.kind).toBe('reconnect-required'));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(auth.getCodexRateLimits).toHaveBeenCalledTimes(1));

    act(() => {
      stateChangedListener(auth)({
        agentKind: 'codex',
        authenticated: false,
        errorReason: 'token_revoked',
        credentialScope: 'instance-isolated',
      });
    });
    let loginOutcome!: Promise<string>;
    act(() => {
      loginOutcome = result.current.triggerLogin();
    });
    await waitFor(() => expect(auth.getCodexRateLimits).toHaveBeenCalledTimes(2));

    await act(async () => {
      firstProbe.resolve({ rateLimits: null, resetOffer: null });
      await firstProbe.promise;
    });
    expect(result.current.state.kind).not.toBe('authenticated');
    expect(result.current.recoveryCheck).toBe('checking');

    await act(async () => {
      secondProbe.resolve({ rateLimits: null, resetOffer: null });
      await expect(loginOutcome).resolves.toBe('authenticated');
    });
    expect(result.current.state).toMatchObject({
      kind: 'authenticated',
      identity: 'new@example.com',
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
        credentialScope: 'system-shared',
      });
    });

    expect(result.current.state).toEqual({
      kind: 'reconnect-required',
      reason: 'token_revoked',
      credentialScope: 'system-shared',
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
        credentialScope: 'system-shared',
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
      credentialScope: 'system-shared',
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
