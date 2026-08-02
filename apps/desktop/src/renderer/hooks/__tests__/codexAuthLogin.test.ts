// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('triggerCodexLoginOnce', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('coalesces only the same mode and serializes a conflicting mode after cancellation', async () => {
    const browser = deferred<{ authenticated: boolean }>();
    const triggerLogin = vi.fn((_: string, options?: { mode?: string; ownerId?: string }) =>
      options?.mode === 'device-code' ? Promise.resolve({ authenticated: true }) : browser.promise,
    );
    const cancelLogin = vi.fn(async () => undefined);
    Object.assign(window, {
      electronAPI: {
        maker: { auth: { triggerLogin, cancelLogin } },
      },
    });
    const { triggerCodexLoginOnce } = await import('../codexAuthLogin');

    const first = triggerCodexLoginOnce('browser');
    const duplicate = triggerCodexLoginOnce('browser');
    const deviceCode = triggerCodexLoginOnce('device-code');
    await Promise.resolve();

    expect(duplicate).toBe(first);
    expect(cancelLogin).toHaveBeenCalledWith('codex', {
      releaseOwner: true,
      ownerId: triggerLogin.mock.calls[0]?.[1]?.ownerId,
    });
    expect(triggerLogin).toHaveBeenCalledTimes(1);

    browser.resolve({ authenticated: false });
    await expect(first).resolves.toEqual({ authenticated: false });
    await expect(deviceCode).resolves.toEqual({ authenticated: true });
    expect(triggerLogin).toHaveBeenNthCalledWith(
      2,
      'codex',
      expect.objectContaining({ mode: 'device-code', ownerId: expect.any(String) }),
    );
  });

  it('does not start a queued mode switch after renderer cancellation', async () => {
    const browser = deferred<{ authenticated: boolean }>();
    const triggerLogin = vi.fn(() => browser.promise);
    const cancelLogin = vi.fn(async () => undefined);
    Object.assign(window, {
      electronAPI: {
        maker: { auth: { triggerLogin, cancelLogin } },
      },
    });
    const { invalidatePendingCodexLogin, triggerCodexLoginOnce } =
      await import('../codexAuthLogin');

    const first = triggerCodexLoginOnce('browser');
    const queued = triggerCodexLoginOnce('device-code');
    invalidatePendingCodexLogin();
    browser.resolve({ authenticated: false });

    await expect(first).resolves.toEqual({ authenticated: false });
    await expect(queued).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    expect(triggerLogin).toHaveBeenCalledTimes(1);
  });

  it('isolates login-start listener failures from later listeners and the login IPC', async () => {
    const triggerLogin = vi.fn(async () => ({ authenticated: true }));
    const cancelLogin = vi.fn(async () => undefined);
    Object.assign(window, {
      electronAPI: {
        maker: { auth: { triggerLogin, cancelLogin } },
      },
    });
    const { onCodexLoginStarted, triggerCodexLoginOnce } = await import('../codexAuthLogin');
    const laterListener = vi.fn();
    const offThrowing = onCodexLoginStarted(() => {
      throw new Error('observer failed');
    });
    const offLater = onCodexLoginStarted(laterListener);

    await expect(triggerCodexLoginOnce('browser')).resolves.toEqual({ authenticated: true });

    expect(laterListener).toHaveBeenCalledOnce();
    expect(triggerLogin).toHaveBeenCalledOnce();
    offThrowing();
    offLater();
  });

  it('continues a mode switch when cancellation throws synchronously', async () => {
    const browser = deferred<{ authenticated: boolean }>();
    const triggerLogin = vi.fn((_: string, options?: { mode?: string; ownerId?: string }) =>
      options?.mode === 'device-code' ? Promise.resolve({ authenticated: true }) : browser.promise,
    );
    const cancelLogin = vi.fn(() => {
      throw new Error('bridge unavailable');
    });
    Object.assign(window, {
      electronAPI: {
        maker: { auth: { triggerLogin, cancelLogin } },
      },
    });
    const { triggerCodexLoginOnce } = await import('../codexAuthLogin');

    const first = triggerCodexLoginOnce('browser');
    let deviceCode!: Promise<{ authenticated: boolean }>;
    expect(() => {
      deviceCode = triggerCodexLoginOnce('device-code');
    }).not.toThrow();

    browser.resolve({ authenticated: false });
    await expect(first).resolves.toEqual({ authenticated: false });
    await expect(deviceCode).resolves.toEqual({ authenticated: true });
    expect(triggerLogin).toHaveBeenNthCalledWith(
      2,
      'codex',
      expect.objectContaining({ mode: 'device-code', ownerId: expect.any(String) }),
    );
  });

  it('cancels a shared login only after its last explicit owner releases', async () => {
    const login = deferred<{ authenticated: boolean; errorReason?: string }>();
    const triggerLogin = vi.fn(() => login.promise);
    const cancelLogin = vi.fn(async () => undefined);
    Object.assign(window, {
      electronAPI: {
        maker: { auth: { triggerLogin, cancelLogin } },
      },
    });
    const { acquireCodexLogin } = await import('../codexAuthLogin');

    const first = acquireCodexLogin('device-code');
    const second = acquireCodexLogin('device-code');
    expect(first.promise).toBe(second.promise);
    expect(triggerLogin).toHaveBeenCalledOnce();

    first.release({ cancelIfLastOwner: true });
    expect(cancelLogin).not.toHaveBeenCalled();

    second.release({ cancelIfLastOwner: true });
    expect(cancelLogin).toHaveBeenCalledOnce();
    expect(cancelLogin).toHaveBeenCalledWith('codex', {
      releaseOwner: true,
      ownerId: expect.any(String),
    });

    login.resolve({ authenticated: false, errorReason: 'login_cancelled' });
    await expect(first.promise).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
  });

  it('does not let an old-mode owner cleanup cancel the queued new-mode login', async () => {
    const browser = deferred<{ authenticated: boolean; errorReason?: string }>();
    const deviceCode = deferred<{ authenticated: boolean; errorReason?: string }>();
    const triggerLogin = vi.fn((_: string, options?: { mode?: string; ownerId?: string }) =>
      options?.mode === 'device-code' ? deviceCode.promise : browser.promise,
    );
    const cancelLogin = vi.fn(async () => undefined);
    Object.assign(window, {
      electronAPI: {
        maker: { auth: { triggerLogin, cancelLogin } },
      },
    });
    const { acquireCodexLogin } = await import('../codexAuthLogin');

    const browserOwner = acquireCodexLogin('browser');
    const deviceOwner = acquireCodexLogin('device-code');
    expect(cancelLogin).toHaveBeenCalledOnce();
    expect(cancelLogin).toHaveBeenLastCalledWith('codex', {
      releaseOwner: true,
      ownerId: triggerLogin.mock.calls[0]?.[1]?.ownerId,
    });

    browserOwner.release({ cancelIfLastOwner: true });
    expect(cancelLogin).toHaveBeenCalledOnce();

    browser.resolve({ authenticated: false, errorReason: 'login_cancelled' });
    await expect(browserOwner.promise).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    await vi.waitFor(() =>
      expect(triggerLogin).toHaveBeenNthCalledWith(
        2,
        'codex',
        expect.objectContaining({ mode: 'device-code', ownerId: expect.any(String) }),
      ),
    );

    deviceOwner.release({ cancelIfLastOwner: true });
    expect(cancelLogin).toHaveBeenCalledTimes(2);
    expect(cancelLogin).toHaveBeenLastCalledWith('codex', {
      releaseOwner: true,
      ownerId: expect.any(String),
    });
    deviceCode.resolve({ authenticated: false, errorReason: 'login_cancelled' });
    await expect(deviceOwner.promise).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
  });
});
