import type { AgentLoginMode, AuthLoginOptions, AuthState } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ userDataDir: '/tmp/cindy-codex-login-concurrency' }));

vi.mock('electron', () => ({
  app: {
    getPath: () => h.userDataDir,
    getAppPath: () => h.userDataDir,
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock('@cindy/maker-core', () => ({}));

describe('DesktopCodexAuthAdapter login single-flight', () => {
  it('rolls back credentials when Cancel arrives during successful-login finalization', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as InstanceType<
      typeof DesktopCodexAuthAdapter
    >;
    let finishLocalRead!: (state: AuthState) => void;
    const readLocalCodexAuthState = vi.fn(() => new Promise<AuthState>((resolve) => {
      finishLocalRead = resolve;
    }));
    const disconnectCodexOAuth = vi.fn().mockResolvedValue(undefined);
    const pending = {
      mode: 'browser' as const,
      promise: Promise.resolve({ authenticated: false }),
      progressListeners: new Set(),
      progressHistory: [],
      progressHistoryChars: 0,
      cancelled: false,
    };
    Object.defineProperties(adapter, {
      codexHome: { configurable: true, value: h.userDataDir },
      readLocalCodexAuthState: { configurable: true, value: readLocalCodexAuthState },
      disconnectCodexOAuth: { configurable: true, value: disconnectCodexOAuth },
      pendingLogin: { configurable: true, writable: true, value: pending },
      loginCancellationOpen: { configurable: true, writable: true, value: true },
      loginAborted: { configurable: true, writable: true, value: false },
      currentLoginProc: { configurable: true, writable: true, value: null },
    });
    const finishSuccessfulCodexLogin = (
      adapter as unknown as {
        finishSuccessfulCodexLogin(
          fallback: AuthState | undefined,
          isCancelled: () => boolean,
        ): Promise<AuthState>;
      }
    ).finishSuccessfulCodexLogin.bind(adapter);

    const result = finishSuccessfulCodexLogin(undefined, () => pending.cancelled);
    await vi.waitFor(() => expect(readLocalCodexAuthState).toHaveBeenCalledOnce());
    adapter.cancelLogin();
    finishLocalRead({ authenticated: true, authSource: 'oauth' });

    await expect(result).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    expect(disconnectCodexOAuth).toHaveBeenCalledOnce();
  });

  it('coalesces the same mode but cancels and serializes a different mode', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as InstanceType<
      typeof DesktopCodexAuthAdapter
    >;

    let finishBrowser!: (state: AuthState) => void;
    const browserRun = new Promise<AuthState>((resolve) => {
      finishBrowser = resolve;
    });
    let browserOptions: AuthLoginOptions | undefined;
    const runTriggerLogin = vi.fn((opts?: AuthLoginOptions): Promise<AuthState> => {
      const mode: AgentLoginMode = opts?.mode ?? 'browser';
      if (mode === 'browser') browserOptions = opts;
      return mode === 'browser'
        ? browserRun
        : Promise.resolve({ authenticated: true, authSource: 'oauth' });
    });
    Object.defineProperty(adapter, 'runTriggerLogin', {
      configurable: true,
      value: runTriggerLogin,
    });
    const cancelLogin = vi.spyOn(adapter, 'cancelLogin').mockImplementation(() => {});

    const firstProgress = vi.fn();
    const duplicateProgress = vi.fn();
    const firstBrowser = adapter.triggerLogin({ mode: 'browser', onProgress: firstProgress });
    const duplicateBrowser = adapter.triggerLogin({ mode: 'browser', onProgress: duplicateProgress });
    browserOptions?.onProgress?.('stdout:Authorize at https://example.com/device');
    const deviceCode = adapter.triggerLogin({ mode: 'device-code' });

    expect(duplicateBrowser).toBe(firstBrowser);
    expect(firstProgress).toHaveBeenCalledOnce();
    expect(duplicateProgress).toHaveBeenCalledOnce();
    expect(runTriggerLogin).toHaveBeenCalledTimes(1);
    expect(cancelLogin).toHaveBeenCalledOnce();
    expect(
      (adapter as unknown as { pendingLogin: { mode: AgentLoginMode; promise: Promise<AuthState> } })
        .pendingLogin,
    ).toMatchObject({ mode: 'device-code', promise: deviceCode });

    finishBrowser({ authenticated: false, errorReason: 'login_cancelled' });
    await expect(firstBrowser).resolves.toMatchObject({ errorReason: 'login_cancelled' });
    await expect(deviceCode).resolves.toMatchObject({
      authenticated: true,
      authSource: 'oauth',
    });
    expect(runTriggerLogin).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        mode: 'device-code',
        onProgress: expect.any(Function),
      }),
      expect.any(Function),
    );
  });

  it('lets a later logout-style cancellation cancel a queued mode switch before it starts', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as InstanceType<
      typeof DesktopCodexAuthAdapter
    >;
    let finishBrowser!: (state: AuthState) => void;
    const browserRun = new Promise<AuthState>((resolve) => {
      finishBrowser = resolve;
    });
    const runTriggerLogin = vi.fn((opts?: AuthLoginOptions): Promise<AuthState> =>
      (opts?.mode ?? 'browser') === 'browser'
        ? browserRun
        : Promise.resolve({ authenticated: true, authSource: 'oauth' }),
    );
    Object.defineProperty(adapter, 'runTriggerLogin', {
      configurable: true,
      value: runTriggerLogin,
    });
    Object.defineProperty(adapter, 'loginCancellationOpen', {
      configurable: true,
      writable: true,
      value: true,
    });

    const browser = adapter.triggerLogin({ mode: 'browser' });
    const deviceCode = adapter.triggerLogin({ mode: 'device-code' });
    adapter.cancelLogin();
    finishBrowser({ authenticated: false, errorReason: 'login_cancelled' });

    await expect(browser).resolves.toMatchObject({ errorReason: 'login_cancelled' });
    await expect(deviceCode).resolves.toMatchObject({ errorReason: 'login_cancelled' });
    expect(runTriggerLogin).toHaveBeenCalledTimes(1);
  });

  it('restarts a cancelled same-mode login after the cancelled operation settles', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as InstanceType<
      typeof DesktopCodexAuthAdapter
    >;
    let finishFirst!: (state: AuthState) => void;
    const firstRun = new Promise<AuthState>((resolve) => {
      finishFirst = resolve;
    });
    const runTriggerLogin = vi.fn()
      .mockReturnValueOnce(firstRun)
      .mockResolvedValueOnce({ authenticated: true, authSource: 'oauth' });
    Object.defineProperty(adapter, 'runTriggerLogin', {
      configurable: true,
      value: runTriggerLogin,
    });

    const first = adapter.triggerLogin({ mode: 'browser' });
    adapter.cancelLogin();
    const retry = adapter.triggerLogin({ mode: 'browser' });

    expect(retry).not.toBe(first);
    expect(runTriggerLogin).toHaveBeenCalledTimes(1);
    finishFirst({ authenticated: false, errorReason: 'login_cancelled' });
    await expect(first).resolves.toMatchObject({ errorReason: 'login_cancelled' });
    await expect(retry).resolves.toMatchObject({
      authenticated: true,
      authSource: 'oauth',
    });
    expect(runTriggerLogin).toHaveBeenCalledTimes(2);
  });

  it('queues a mode switch behind both the cancelled login and an active logout', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as InstanceType<
      typeof DesktopCodexAuthAdapter
    >;
    let finishBrowser!: (state: AuthState) => void;
    const browserRun = new Promise<AuthState>((resolve) => {
      finishBrowser = resolve;
    });
    let finishLogout!: () => void;
    const logoutOperation = new Promise<void>((resolve) => {
      finishLogout = resolve;
    });
    const runTriggerLogin = vi.fn((opts?: AuthLoginOptions): Promise<AuthState> =>
      (opts?.mode ?? 'browser') === 'browser'
        ? browserRun
        : Promise.resolve({ authenticated: true, authSource: 'oauth' }),
    );
    Object.defineProperty(adapter, 'runTriggerLogin', {
      configurable: true,
      value: runTriggerLogin,
    });

    const browser = adapter.triggerLogin({ mode: 'browser' });
    Object.defineProperty(adapter, 'logoutOperation', {
      configurable: true,
      writable: true,
      value: logoutOperation,
    });
    const deviceCode = adapter.triggerLogin({ mode: 'device-code' });
    finishBrowser({ authenticated: false, errorReason: 'login_cancelled' });
    await expect(browser).resolves.toMatchObject({ errorReason: 'login_cancelled' });
    await Promise.resolve();
    expect(runTriggerLogin).toHaveBeenCalledTimes(1);

    finishLogout();
    await expect(deviceCode).resolves.toMatchObject({
      authenticated: true,
      authSource: 'oauth',
    });
    expect(runTriggerLogin).toHaveBeenCalledTimes(2);
  });

  it('queues a new login until an in-flight logout fully settles', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as InstanceType<
      typeof DesktopCodexAuthAdapter
    >;
    let finishLogout!: () => void;
    const logoutOperation = new Promise<void>((resolve) => {
      finishLogout = resolve;
    });
    Object.defineProperty(adapter, 'logoutOperation', {
      configurable: true,
      writable: true,
      value: logoutOperation,
    });
    const runTriggerLogin = vi.fn(async (): Promise<AuthState> => ({
      authenticated: true,
      authSource: 'oauth',
    }));
    Object.defineProperty(adapter, 'runTriggerLogin', {
      configurable: true,
      value: runTriggerLogin,
    });

    const login = adapter.triggerLogin({ mode: 'device-code' });
    await Promise.resolve();
    expect(runTriggerLogin).not.toHaveBeenCalled();

    finishLogout();
    await expect(login).resolves.toMatchObject({
      authenticated: true,
      authSource: 'oauth',
    });
    expect(runTriggerLogin).toHaveBeenCalledOnce();
  });

  it('lets a repeated logout cancel a login queued behind the active logout', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as InstanceType<
      typeof DesktopCodexAuthAdapter
    >;
    let finishLogout!: () => void;
    const logoutOperation = new Promise<void>((resolve) => {
      finishLogout = resolve;
    });
    Object.defineProperty(adapter, 'logoutOperation', {
      configurable: true,
      writable: true,
      value: logoutOperation,
    });
    const runTriggerLogin = vi.fn(async (): Promise<AuthState> => ({
      authenticated: true,
      authSource: 'oauth',
    }));
    Object.defineProperty(adapter, 'runTriggerLogin', {
      configurable: true,
      value: runTriggerLogin,
    });

    const queuedLogin = adapter.triggerLogin({ mode: 'device-code' });
    const repeatedLogout = adapter.logout();
    expect(repeatedLogout).toBe(logoutOperation);

    finishLogout();
    await expect(queuedLogin).resolves.toMatchObject({ errorReason: 'login_cancelled' });
    expect(runTriggerLogin).not.toHaveBeenCalled();
  });
});
