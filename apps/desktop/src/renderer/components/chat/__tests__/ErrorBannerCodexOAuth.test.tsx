// @vitest-environment jsdom

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBanner } from '../ErrorBanner';
import { useCodexAuth } from '@/hooks/useCodexAuth';
import { useCodexSessionExpiredPrompt } from '@/hooks/useCodexSessionExpiredPrompt';

type AuthStateChangedPayload = {
  agentKind: 'claude-code' | 'codex';
  authenticated: boolean;
  identity?: string;
  expiresAt?: number;
  errorReason?: string;
  authSource?: 'oauth' | 'api-key';
};

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  getState: vi.fn(),
  triggerLogin: vi.fn(),
  cancelLogin: vi.fn(),
  logout: vi.fn(),
  onStateChanged: vi.fn(),
  onLoginProgress: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  runtimeRoute: vi.fn(() => ({ authInjection: 'env-key' as const })),
  stateChangedListeners: new Set<(payload: AuthStateChangedPayload) => void>(),
}));

function emitCodexStateChanged(payload: Omit<AuthStateChangedPayload, 'agentKind'>): void {
  for (const listener of mocks.stateChangedListeners) {
    listener({ agentKind: 'codex', ...payload });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('@/hooks/useCodexRuntimeRoute', () => ({
  // invalidate 会在横幅渲染前把已收割的 OAuth host 回落为 env-key；明确失效原因
  // 仍必须保留 ChatGPT 重连入口。
  useCodexRuntimeRoute: mocks.runtimeRoute,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

describe('ErrorBanner OpenAI connection recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stateChangedListeners.clear();
    mocks.getState.mockResolvedValue({
      authenticated: false,
      errorReason: 'refresh_token_reused',
    });
    mocks.triggerLogin.mockImplementation(async () => {
      const result = {
        authenticated: true,
        identity: 'user@example.com',
        authSource: 'oauth' as const,
      };
      emitCodexStateChanged(result);
      return result;
    });
    mocks.cancelLogin.mockResolvedValue(undefined);
    mocks.logout.mockResolvedValue(undefined);
    mocks.onStateChanged.mockImplementation(
      (listener: (payload: AuthStateChangedPayload) => void) => {
        mocks.stateChangedListeners.add(listener);
        return () => mocks.stateChangedListeners.delete(listener);
      },
    );
    mocks.onLoginProgress.mockReturnValue(() => undefined);
    (
      window as unknown as {
        electronAPI: {
          maker: {
            auth: {
              getState: typeof mocks.getState;
              triggerLogin: typeof mocks.triggerLogin;
              cancelLogin: typeof mocks.cancelLogin;
              logout: typeof mocks.logout;
              onStateChanged: typeof mocks.onStateChanged;
              onLoginProgress: typeof mocks.onLoginProgress;
            };
          };
        };
      }
    ).electronAPI = {
      maker: {
        auth: {
          getState: mocks.getState,
          triggerLogin: mocks.triggerLogin,
          cancelLogin: mocks.cancelLogin,
          logout: mocks.logout,
          onStateChanged: mocks.onStateChanged,
          onLoginProgress: mocks.onLoginProgress,
        },
      },
    };
  });

  it('waits for an explicit inline action and restores retry after success', async () => {
    const { rerender } = render(
      <ErrorBanner
        error="refresh_token_reused"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
        providerId="openai"
      />,
    );

    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.triggerLogin).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    );

    await waitFor(() =>
      expect(mocks.triggerLogin).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ ownerId: expect.any(String) }),
      ),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('logic.toasts.codexConnected');
    expect(await screen.findByText('chat.errorBanner.codexSessionReconnected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();

    act(() => {
      emitCodexStateChanged({ authenticated: false, errorReason: 'token_invalidated' });
      rerender(
        <ErrorBanner
          error="token_invalidated"
          retryText="retry another turn"
          onRetry={vi.fn()}
          agentKind="codex"
          modelId="gpt-5.4"
          providerId="openai"
        />,
      );
    });
    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.codexSessionReconnected')).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();
  });

  it('keeps the reconnect action after user cancellation without showing an error toast', async () => {
    mocks.triggerLogin.mockResolvedValue({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    render(
      <ErrorBanner
        error="token_revoked"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    );

    await waitFor(() =>
      expect(mocks.triggerLogin).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ ownerId: expect.any(String) }),
      ),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();
  });

  it('keeps the reconnect action and shows actionable copy after timeout', async () => {
    mocks.triggerLogin.mockResolvedValue({
      authenticated: false,
      errorReason: 'login_timeout',
    });
    render(
      <ErrorBanner
        error="token_invalidated"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    );

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('settings.connections.codex.toast.loginFailed');
    });
    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();
  });

  it('uses the same inline recovery for Claude models backed by ChatGPT', async () => {
    render(
      <ErrorBanner
        error="bridge auth unavailable for chatgpt/ (subscription login may have expired)"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="cc"
        modelId="chatgpt/gpt-5.4"
      />,
    );

    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(mocks.confirm).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    );

    await waitFor(() =>
      expect(mocks.triggerLogin).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ ownerId: expect.any(String) }),
      ),
    );
    expect(await screen.findByText('chat.errorBanner.codexSessionReconnected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();
  });

  it('classifies the wrapped thread/resume refresh-token failure as reconnect, not retry', () => {
    render(
      <ErrorBanner
        error="LAZY_CREATE_FAILED: Failed to resume Codex thread: Error: codex app-server thread/resume error -32600: failed to load configuration: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again."
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
        providerId="openai"
      />,
    );

    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();
  });

  it('does not classify a non-OpenAI provider error as ChatGPT reconnect', () => {
    render(
      <ErrorBanner
        error="token_revoked"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="xai/grok-4"
        providerId="xai"
      />,
    );

    expect(screen.getByText('token_revoked')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();
    expect(mocks.getState).not.toHaveBeenCalled();
    expect(mocks.stateChangedListeners.size).toBe(0);
  });

  it('does not redirect an explicit custom provider OAuth failure to ChatGPT reconnect', () => {
    render(
      <ErrorBanner
        error="token_revoked"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="custom-model"
        providerId="custom-oauth"
      />,
    );

    expect(screen.getByText('token_revoked')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();
    expect(mocks.getState).not.toHaveBeenCalled();
    expect(mocks.stateChangedListeners.size).toBe(0);
  });

  it.each([
    {
      label: 'device-link Codex',
      agentKind: 'codex' as const,
      error: 'token_invalidated',
      modelId: 'gpt-5.4',
      providerId: 'openai',
      deviceLinkDeviceId: 'device-1',
    },
    {
      label: 'device-link Claude ChatGPT bridge',
      agentKind: 'cc' as const,
      error: 'bridge auth unavailable for chatgpt/ (subscription login may have expired)',
      modelId: 'chatgpt/gpt-5.4',
      providerId: 'openai',
      deviceLinkDeviceId: 'device-1',
    },
    {
      label: 'SSH Claude ChatGPT bridge',
      agentKind: 'cc' as const,
      error: 'bridge auth unavailable for chatgpt/ (subscription login may have expired)',
      modelId: 'chatgpt/gpt-5.4',
      providerId: 'openai',
      remoteHostId: 'ssh-1',
    },
  ])('does not reconnect the controller for a $label failure', (props) => {
    render(<ErrorBanner {...props} retryText="retry this turn" onRetry={vi.fn()} />);

    expect(screen.getByText(props.error)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();
    expect(mocks.getState).not.toHaveBeenCalled();
    expect(mocks.stateChangedListeners.size).toBe(0);
    if (props.agentKind === 'codex') {
      expect(mocks.runtimeRoute).toHaveBeenLastCalledWith({ enabled: false });
    }
  });

  it('restores retry after reconnect succeeds from the settings auth hook', async () => {
    const settingsAuth = renderHook(() => useCodexAuth());
    render(
      <ErrorBanner
        error="refresh_token_reused"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
      />,
    );

    await waitFor(() => expect(settingsAuth.result.current.state.kind).toBe('reconnect-required'));
    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(mocks.triggerLogin).not.toHaveBeenCalled();

    await act(async () => {
      await expect(settingsAuth.result.current.triggerLogin()).resolves.toBe('authenticated');
    });

    expect(await screen.findByText('chat.errorBanner.codexSessionReconnected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();
    expect(mocks.triggerLogin).toHaveBeenCalledOnce();
  });

  it('does not reuse recovered state after auth observation was disabled by another error', async () => {
    const refreshedState = deferred<AuthStateChangedPayload>();
    mocks.getState
      .mockResolvedValueOnce({
        authenticated: true,
        identity: 'user@example.com',
        authSource: 'oauth',
      })
      .mockImplementationOnce(() => refreshedState.promise);
    const { rerender } = render(
      <ErrorBanner
        error="refresh_token_reused"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
      />,
    );

    expect(await screen.findByText('chat.errorBanner.codexSessionReconnected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();

    rerender(
      <ErrorBanner
        error="unrelated failure"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
      />,
    );
    expect(mocks.stateChangedListeners.size).toBe(0);
    emitCodexStateChanged({ authenticated: false, errorReason: 'token_revoked' });

    rerender(
      <ErrorBanner
        error="token_revoked"
        retryText="retry another turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
      />,
    );

    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.codexSessionReconnected')).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();

    await act(async () => {
      refreshedState.resolve({
        agentKind: 'codex',
        authenticated: false,
        errorReason: 'token_revoked',
      });
      await refreshedState.promise;
    });
    expect(screen.getByText('chat.errorBanner.codexSessionExpired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();
  });

  it('joins an OAuth flow already started from the settings auth hook', async () => {
    const login = deferred<{ authenticated: boolean; authSource: 'oauth' }>();
    mocks.triggerLogin.mockImplementation(() => login.promise);
    const settingsAuth = renderHook(() => useCodexAuth());
    await waitFor(() => expect(settingsAuth.result.current.state.kind).toBe('reconnect-required'));

    let settingsOutcome!: ReturnType<typeof settingsAuth.result.current.triggerLogin>;
    act(() => {
      settingsOutcome = settingsAuth.result.current.triggerLogin();
    });

    render(
      <ErrorBanner
        error="refresh_token_reused"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.codexSessionExpiredLogin' }),
    );

    await waitFor(() => expect(mocks.triggerLogin).toHaveBeenCalledOnce());
    await act(async () => {
      emitCodexStateChanged({ authenticated: true, authSource: 'oauth' });
      login.resolve({ authenticated: true, authSource: 'oauth' });
      await expect(settingsOutcome).resolves.toBe('authenticated');
    });

    expect(await screen.findByText('chat.errorBanner.codexSessionReconnected')).toBeTruthy();
    expect(mocks.triggerLogin).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ ownerId: expect.any(String) }),
    );
  });

  it('cancels an owned reconnect when its prompt owner unmounts', async () => {
    const login = deferred<AuthStateChangedPayload>();
    mocks.triggerLogin.mockImplementation(() => login.promise);
    const prompt = renderHook(() =>
      useCodexSessionExpiredPrompt({ confirmBeforeLogin: false }),
    );

    act(() => {
      expect(prompt.result.current('token_revoked')).toBe(true);
    });
    await waitFor(() =>
      expect(mocks.triggerLogin).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ ownerId: expect.any(String) }),
      ),
    );

    prompt.unmount();
    expect(mocks.cancelLogin).toHaveBeenCalledOnce();
    expect(mocks.cancelLogin).toHaveBeenCalledWith('codex', {
      releaseOwner: true,
      ownerId: expect.any(String),
    });

    await act(async () => {
      login.resolve({
        agentKind: 'codex',
        authenticated: false,
        errorReason: 'login_cancelled',
      });
      await login.promise;
    });
  });

  it('does not start reconnect after unmount while confirmation is pending', async () => {
    const confirmation = deferred<boolean>();
    mocks.confirm.mockImplementationOnce(() => confirmation.promise);
    const prompt = renderHook(() => useCodexSessionExpiredPrompt());

    act(() => {
      expect(prompt.result.current('token_revoked')).toBe(true);
    });
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());

    prompt.unmount();
    await act(async () => {
      confirmation.resolve(true);
      await confirmation.promise;
    });

    expect(mocks.triggerLogin).not.toHaveBeenCalled();
    expect(mocks.cancelLogin).not.toHaveBeenCalled();
  });

  it('exposes the explicit Continue After Reset action only when provided', () => {
    const onContinueAfterUsageReset = vi.fn();
    const { rerender } = render(
      <ErrorBanner
        error="Usage limit reached"
        retryText="retry this turn"
        onRetry={vi.fn()}
        onContinueAfterUsageReset={onContinueAfterUsageReset}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.continueAfterReset' }),
    );
    expect(onContinueAfterUsageReset).toHaveBeenCalledOnce();

    rerender(
      <ErrorBanner
        error="A normal failure"
        retryText="retry this turn"
        onRetry={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'chat.errorBanner.continueAfterReset' }),
    ).toBeNull();
  });
});
