// @vitest-environment jsdom

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_RESUME_NOT_READY_WIRE_MESSAGE } from '@cindy/maker-shared/agent-input-projection';

import { ErrorBanner } from '../ErrorBanner';
import { ErrorTailErrorBanner } from '../InterruptedTurnBanner';
import { useCodexAuth } from '@/hooks/useCodexAuth';
import { useCodexSessionExpiredPrompt } from '@/hooks/useCodexSessionExpiredPrompt';
import {
  CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON,
  CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON,
} from '../../../../shared/claudeGatewayError';

type AuthStateChangedPayload = {
  agentKind: 'claude-code' | 'codex';
  authenticated: boolean;
  identity?: string;
  expiresAt?: number;
  errorReason?: string;
  authSource?: 'oauth' | 'api-key';
  credentialScope?: 'system-shared' | 'instance-isolated' | 'unknown';
  recoveryRequiredReason?: string;
};

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  getState: vi.fn(),
  triggerLogin: vi.fn(),
  cancelLogin: vi.fn(),
  logout: vi.fn(),
  onStateChanged: vi.fn(),
  onLoginProgress: vi.fn(),
  getCodexRateLimits: vi.fn(),
  openChatGPTApp: vi.fn(),
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
      mocks.getState.mockResolvedValue(result);
      emitCodexStateChanged(result);
      return result;
    });
    mocks.cancelLogin.mockResolvedValue(undefined);
    mocks.logout.mockResolvedValue(undefined);
    mocks.getCodexRateLimits.mockResolvedValue({ rateLimits: null, resetOffer: null });
    mocks.openChatGPTApp.mockResolvedValue({ success: true });
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
            usage: { getCodexRateLimits: typeof mocks.getCodexRateLimits };
          };
          openChatGPTApp: typeof mocks.openChatGPTApp;
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
        usage: { getCodexRateLimits: mocks.getCodexRateLimits },
      },
      openChatGPTApp: mocks.openChatGPTApp,
    };
  });

  it('localizes the Codex resume preflight marker without exposing the host envelope', () => {
    const error = `LAZY_CREATE_FAILED: ${CODEX_RESUME_NOT_READY_WIRE_MESSAGE}`;
    render(
      <ErrorBanner error={error} retryText="retry this turn" onRetry={vi.fn()} agentKind="codex" />,
    );

    expect(screen.getByText('chat.errorBanner.codexResumeNotReady')).toBeTruthy();
    expect(screen.queryByText(error)).toBeNull();
  });

  it('starts Cindy login for an invalidated system-shared login', async () => {
    mocks.getState.mockResolvedValue({
      authenticated: false,
      errorReason: 'token_revoked',
      credentialScope: 'system-shared',
    });
    render(
      <ErrorBanner
        error="token_revoked"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
        providerId="openai"
      />,
    );

    expect(await screen.findByText('chatgptAuthRecovery.systemSharedInvalidated')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'chatgptAuthRecovery.relogin' }));

    await waitFor(() => expect(mocks.triggerLogin).toHaveBeenCalledOnce());
    expect(mocks.openChatGPTApp).not.toHaveBeenCalled();
    expect(await screen.findByText('chatgptAuthRecovery.recovered')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();
  });

  it('keeps the recovery action disabled until the credential source is known', async () => {
    const initialState = deferred<AuthStateChangedPayload>();
    mocks.getState.mockImplementationOnce(() => initialState.promise);
    render(
      <ErrorBanner
        error="token_revoked"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
        providerId="openai"
      />,
    );

    const checkingButton = screen.getByRole('button', {
      name: 'chatgptAuthRecovery.checking',
    }) as HTMLButtonElement;
    expect(checkingButton.disabled).toBe(true);
    fireEvent.click(checkingButton);
    expect(mocks.triggerLogin).not.toHaveBeenCalled();
    expect(mocks.openChatGPTApp).not.toHaveBeenCalled();

    await act(async () => {
      initialState.resolve({
        agentKind: 'codex',
        authenticated: false,
        errorReason: 'token_revoked',
        credentialScope: 'system-shared',
      });
      await initialState.promise;
    });
    expect(await screen.findByRole('button', { name: 'chatgptAuthRecovery.relogin' })).toBeTruthy();
  });

  it('does not restore retry on a fresh mount until the replacement account probe succeeds', async () => {
    const verification = deferred<{ rateLimits: null; resetOffer: null }>();
    mocks.getState
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
    mocks.getCodexRateLimits.mockImplementationOnce(() => verification.promise);
    render(
      <ErrorBanner
        error="token_revoked"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
        providerId="openai"
      />,
    );

    expect(await screen.findByText('chatgptAuthRecovery.systemSharedInvalidated')).toBeTruthy();
    expect(screen.queryByText('chatgptAuthRecovery.recovered')).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();

    await act(async () => {
      verification.resolve({ rateLimits: null, resetOffer: null });
      await verification.promise;
    });
    expect(await screen.findByText('chatgptAuthRecovery.recovered')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();
  });

  it('keeps the system-shared recovery action after user cancellation', async () => {
    mocks.getState.mockResolvedValue({
      authenticated: false,
      errorReason: 'token_revoked',
      credentialScope: 'system-shared',
    });
    mocks.triggerLogin.mockResolvedValueOnce({
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
        providerId="openai"
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'chatgptAuthRecovery.relogin' }));

    await waitFor(() => expect(mocks.triggerLogin).toHaveBeenCalledOnce());
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.openChatGPTApp).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'chatgptAuthRecovery.relogin' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();
  });

  it('keeps the system-shared recovery action after login failure', async () => {
    mocks.getState.mockResolvedValue({
      authenticated: false,
      errorReason: 'token_revoked',
      credentialScope: 'system-shared',
    });
    mocks.triggerLogin.mockResolvedValueOnce({
      authenticated: false,
      errorReason: 'login_timeout',
    });
    render(
      <ErrorBanner
        error="token_revoked"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
        providerId="openai"
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'chatgptAuthRecovery.relogin' }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('settings.connections.codex.toast.loginFailed');
    });
    expect(mocks.triggerLogin).toHaveBeenCalledOnce();
    expect(mocks.openChatGPTApp).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'chatgptAuthRecovery.relogin' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();
  });

  it('uses Cindy OAuth for an invalidated instance-isolated login', async () => {
    mocks.getState.mockResolvedValue({
      authenticated: false,
      errorReason: 'token_revoked',
      credentialScope: 'instance-isolated',
    });
    render(
      <ErrorBanner
        error="token_revoked"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        modelId="gpt-5.4"
        providerId="openai"
      />,
    );

    expect(await screen.findByText('chatgptAuthRecovery.instanceIsolatedInvalidated')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'chatgptAuthRecovery.relogin' }));

    await waitFor(() => expect(mocks.triggerLogin).toHaveBeenCalledOnce());
    expect(mocks.openChatGPTApp).not.toHaveBeenCalled();
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

    expect(screen.getByText('chatgptAuthRecovery.unknownInvalidated')).toBeTruthy();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.triggerLogin).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'chatgptAuthRecovery.relogin' }));

    await waitFor(() =>
      expect(mocks.triggerLogin).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ ownerId: expect.any(String) }),
      ),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith('logic.toasts.codexConnected'),
    );
    expect(await screen.findByText('chatgptAuthRecovery.recovered')).toBeTruthy();
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
    expect(screen.getByText('chatgptAuthRecovery.unknownInvalidated')).toBeTruthy();
    expect(screen.queryByText('chatgptAuthRecovery.recovered')).toBeNull();
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

    fireEvent.click(await screen.findByRole('button', { name: 'chatgptAuthRecovery.relogin' }));

    await waitFor(() =>
      expect(mocks.triggerLogin).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ ownerId: expect.any(String) }),
      ),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(screen.getByText('chatgptAuthRecovery.unknownInvalidated')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chatgptAuthRecovery.relogin' })).toBeTruthy();
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

    fireEvent.click(await screen.findByRole('button', { name: 'chatgptAuthRecovery.relogin' }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('settings.connections.codex.toast.loginFailed');
    });
    expect(screen.getByText('chatgptAuthRecovery.unknownInvalidated')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chatgptAuthRecovery.relogin' })).toBeTruthy();
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

    expect(screen.getByText('chatgptAuthRecovery.unknownInvalidated')).toBeTruthy();
    expect(mocks.confirm).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'chatgptAuthRecovery.relogin' }));

    await waitFor(() =>
      expect(mocks.triggerLogin).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ ownerId: expect.any(String) }),
      ),
    );
    expect(await screen.findByText('chatgptAuthRecovery.recovered')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();
  });

  it('classifies the wrapped thread/resume refresh-token failure as reconnect, not retry', async () => {
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

    expect(screen.getByText('chatgptAuthRecovery.unknownInvalidated')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'chatgptAuthRecovery.relogin' })).toBeTruthy();
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
    expect(screen.queryByRole('button', { name: 'chatgptAuthRecovery.relogin' })).toBeNull();
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
    expect(screen.queryByRole('button', { name: 'chatgptAuthRecovery.relogin' })).toBeNull();
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
    expect(screen.queryByRole('button', { name: 'chatgptAuthRecovery.relogin' })).toBeNull();
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
    expect(screen.getByText('chatgptAuthRecovery.unknownInvalidated')).toBeTruthy();
    expect(mocks.triggerLogin).not.toHaveBeenCalled();

    await act(async () => {
      await expect(settingsAuth.result.current.triggerLogin()).resolves.toBe('authenticated');
    });

    expect(await screen.findByText('chatgptAuthRecovery.recovered')).toBeTruthy();
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

    expect(await screen.findByText('chatgptAuthRecovery.recovered')).toBeTruthy();
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

    expect(screen.getByText('chatgptAuthRecovery.unknownInvalidated')).toBeTruthy();
    expect(screen.queryByText('chatgptAuthRecovery.recovered')).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();

    await act(async () => {
      refreshedState.resolve({
        agentKind: 'codex',
        authenticated: false,
        errorReason: 'token_revoked',
      });
      await refreshedState.promise;
    });
    expect(screen.getByText('chatgptAuthRecovery.unknownInvalidated')).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('button', { name: 'chatgptAuthRecovery.relogin' }));

    await waitFor(() => expect(mocks.triggerLogin).toHaveBeenCalledOnce());
    await act(async () => {
      mocks.getState.mockResolvedValue({ authenticated: true, authSource: 'oauth' });
      emitCodexStateChanged({ authenticated: true, authSource: 'oauth' });
      login.resolve({ authenticated: true, authSource: 'oauth' });
      await expect(settingsOutcome).resolves.toBe('authenticated');
    });

    expect(await screen.findByText('chatgptAuthRecovery.recovered')).toBeTruthy();
    expect(mocks.triggerLogin).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ ownerId: expect.any(String) }),
    );
  });

  it('cancels an owned reconnect when its prompt owner unmounts', async () => {
    const login = deferred<AuthStateChangedPayload>();
    mocks.triggerLogin.mockImplementation(() => login.promise);
    const prompt = renderHook(() => useCodexSessionExpiredPrompt({ confirmBeforeLogin: false }));

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

  it('uses the system-shared voice recovery copy and starts Cindy login', async () => {
    mocks.getState.mockResolvedValue({
      authenticated: false,
      errorReason: 'token_revoked',
      credentialScope: 'system-shared',
    });
    mocks.confirm.mockResolvedValueOnce(true);
    const prompt = renderHook(() => useCodexSessionExpiredPrompt());

    act(() => {
      expect(prompt.result.current('token_revoked')).toBe(true);
    });

    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith({
        title: 'chatgptAuthRecovery.title',
        description: 'chatgptAuthRecovery.systemSharedInvalidated',
        confirmText: 'chatgptAuthRecovery.relogin',
        cancelText: 'chatgptAuthRecovery.later',
        autoFocusConfirm: true,
      }),
    );
    await waitFor(() => expect(mocks.triggerLogin).toHaveBeenCalledOnce());
    expect(mocks.openChatGPTApp).not.toHaveBeenCalled();
  });

  it('starts Cindy login when an authenticated system-shared hint cannot be verified', async () => {
    mocks.getState.mockResolvedValue({
      authenticated: true,
      identity: 'user@example.com',
      authSource: 'oauth',
      credentialScope: 'system-shared',
    });
    mocks.getCodexRateLimits.mockRejectedValueOnce(new Error('network unavailable'));
    mocks.confirm.mockResolvedValueOnce(true);
    const prompt = renderHook(() => useCodexSessionExpiredPrompt());

    act(() => {
      expect(prompt.result.current('token_revoked')).toBe(true);
    });

    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith({
        title: 'chatgptAuthRecovery.title',
        description: 'chatgptAuthRecovery.systemSharedInvalidated',
        confirmText: 'chatgptAuthRecovery.relogin',
        cancelText: 'chatgptAuthRecovery.later',
        autoFocusConfirm: true,
      }),
    );
    await waitFor(() => expect(mocks.triggerLogin).toHaveBeenCalledOnce());
    expect(mocks.openChatGPTApp).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith('logic.toasts.codexConnected'),
    );
  });

  it('localizes event-loop terminal errors from the stable reason key', () => {
    render(
      <ErrorBanner
        error="Session event loop stopped unexpectedly without a terminal event"
        errorReason="session_event_loop_crashed"
        retryText="retry this turn"
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('logic.errors.turnFailed')).toBeTruthy();
    expect(
      screen.queryByText('Session event loop stopped unexpectedly without a terminal event'),
    ).toBeNull();
  });

  it('exposes the explicit Continue After Reset action only when provided', () => {
    const onContinueAfterUsageReset = vi.fn();
    const { rerender } = render(
      <ErrorBanner
        error="usageLimitExceeded"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        onContinueAfterUsageReset={onContinueAfterUsageReset}
        usageLimitRecovery={{ resetAtMs: null, isAccountUsageLimit: true }}
      />,
    );

    expect(screen.getByText('chat.errorBanner.codexUsageLimit')).toBeTruthy();
    expect(screen.queryByText('usageLimitExceeded')).toBeNull();
    const continueButton = screen.getByRole('button', {
      name: 'chat.errorBanner.continueAfterReset',
    });
    expect(continueButton.getAttribute('data-split-pane-route-action')).toBe('');
    fireEvent.click(continueButton);
    expect(onContinueAfterUsageReset).toHaveBeenCalledOnce();

    rerender(
      <ErrorBanner error="A normal failure" retryText="retry this turn" onRetry={vi.fn()} />,
    );
    expect(
      screen.queryByRole('button', { name: 'chat.errorBanner.continueAfterReset' }),
    ).toBeNull();
  });

  it('explains an organization Codex limit and keeps the raw 429 response available', () => {
    const rawError =
      'API Error: Request rejected (429) · {"error":{"type":"usage_limit_reached","plan_type":"business","resets_at":1788220709}}';
    render(
      <ErrorBanner
        error={rawError}
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        usageLimitRecovery={{
          resetAtMs: Date.parse('2026-08-31T23:58:29.000Z'),
          isAccountUsageLimit: true,
          planType: 'business',
        }}
      />,
    );

    expect(screen.getByText('chat.errorBanner.codexOrganizationUsageLimitWithReset')).toBeTruthy();
    expect(screen.queryByText(rawError)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'chat.errorBanner.networkShowRaw' }));
    expect(screen.getByText(rawError)).toBeTruthy();
  });

  it('falls back to the no-reset-time copy for an out-of-range reset timestamp', () => {
    render(
      <ErrorBanner
        error="usageLimitExceeded"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        usageLimitRecovery={{
          resetAtMs: Number.MAX_VALUE,
          isAccountUsageLimit: true,
          planType: 'business',
        }}
      />,
    );

    expect(screen.getByText('chat.errorBanner.codexOrganizationUsageLimit')).toBeTruthy();
    expect(
      screen.queryByText('chat.errorBanner.codexOrganizationUsageLimitWithReset'),
    ).toBeNull();
  });

  it('keeps a transient Codex 429 on its normal rate-limit path', () => {
    const rawError = 'Too many requests (429)';
    render(
      <ErrorBanner
        error={rawError}
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="codex"
        onContinueAfterUsageReset={vi.fn()}
        usageLimitRecovery={{ resetAtMs: null }}
      />,
    );

    expect(screen.getByText(rawError)).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.codexUsageLimit')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'chat.errorBanner.continueAfterReset' }),
    ).toBeNull();
  });

  it('rebuilds the organization usage-limit hint for a persisted error tail', () => {
    const rawError =
      'API Error: Request rejected (429) · {"error":{"type":"usage_limit_reached","plan_type":"business"}}';
    render(
      <ErrorTailErrorBanner
        errorText={rawError}
        onContinue={vi.fn()}
        onDismiss={vi.fn()}
        agentKind="codex"
      />,
    );

    expect(screen.getByText('chat.errorBanner.codexOrganizationUsageLimit')).toBeTruthy();
    expect(screen.queryByText(rawError)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'chat.errorBanner.networkShowRaw' }));
    expect(screen.getByText(rawError)).toBeTruthy();
  });

  it('does not relabel another agent usage limit as a Codex account limit', () => {
    render(
      <ErrorBanner
        error="You've hit your Claude session limit"
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="cc"
        usageLimitRecovery={{ resetAtMs: null }}
      />,
    );

    expect(screen.getByText("You've hit your Claude session limit")).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.codexUsageLimit')).toBeNull();
  });

  it('replaces the misleading Claude Pro error with its XD Gateway attribution', () => {
    render(
      <ErrorBanner
        error="Claude Opus is not available with the Claude Pro plan. Run /logout and /login."
        errorReason={CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON}
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="cc"
        modelId="claude-opus-5"
      />,
    );

    expect(screen.getByText('chat.errorBanner.claudeGatewayOpusPlanMismatch')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'chat.errorBanner.retry' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'chat.errorBanner.switchClaudeSubscription' }),
    ).toBeNull();
  });

  it('replaces unsupported Claude slash-command advice for subscription errors', () => {
    render(
      <ErrorBanner
        error="Claude Opus is not available with the Claude Pro plan. Run /logout and /login."
        errorReason={CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON}
        retryText="retry this turn"
        onRetry={vi.fn()}
        agentKind="cc"
        modelId="claude-opus-5"
      />,
    );

    expect(screen.getByText('chat.errorBanner.claudeSubscriptionOpusPlanMismatch')).toBeTruthy();
    expect(screen.queryByText(/logout|login/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'chat.errorBanner.retry' })).toBeTruthy();
  });

  it('switches the conversation to Claude.ai through the explicit recovery action', async () => {
    const switching = deferred<void>();
    const onSwitchToClaudeSubscription = vi.fn(() => switching.promise);
    render(
      <ErrorBanner
        error="Claude Opus is not available with the Claude Pro plan."
        errorReason={CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON}
        retryText="retry this turn"
        onRetry={vi.fn()}
        onSwitchToClaudeSubscription={onSwitchToClaudeSubscription}
        agentKind="cc"
        modelId="claude-opus-5"
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.switchClaudeSubscription' }),
    );
    expect(onSwitchToClaudeSubscription).toHaveBeenCalledOnce();
    expect(
      (
        screen.getByRole('button', {
          name: 'chat.errorBanner.switchingClaudeSubscription',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await act(async () => {
      switching.resolve();
      await switching.promise;
    });
    expect(
      (
        screen.getByRole('button', {
          name: 'chat.errorBanner.switchClaudeSubscription',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('restores the Claude.ai recovery action when switching fails', async () => {
    const onSwitchToClaudeSubscription = vi.fn(async () => {
      throw new Error('route update failed');
    });
    render(
      <ErrorBanner
        error="Claude Opus is not available with the Claude Pro plan."
        errorReason={CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON}
        retryText="retry this turn"
        onRetry={vi.fn()}
        onSwitchToClaudeSubscription={onSwitchToClaudeSubscription}
        agentKind="cc"
        modelId="claude-opus-5"
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'chat.errorBanner.switchClaudeSubscription' }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'chat.errorBanner.claudeSubscriptionSwitchFailed',
      ),
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'chat.errorBanner.switchClaudeSubscription',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
