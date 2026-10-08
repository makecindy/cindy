import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const bootstrap = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');

describe('production credential recovery wiring', () => {
  it.each([false, true])(
    'checks recovery after a login action settles (rejects=%s)',
    async (rejects) => {
      const start = bootstrap.indexOf("ipcMain.handle('auth:dispatch-login-action',");
      const end = bootstrap.indexOf("ipcMain.handle('auth:get-captcha-challenge-url',", start);
      const compiled = transpileModule(bootstrap.slice(start, end), {
        compilerOptions: { target: ScriptTarget.ES2022 },
      }).outputText;
      let handler!: (event: unknown, action: unknown) => Promise<unknown>;
      let settle!: () => void;
      const outcome = rejects
        ? new Error('storage unavailable')
        : { success: false, code: 'CREDENTIAL_STORE_UNAVAILABLE' };
      const dispatch = vi.fn(
        () =>
          new Promise((resolve, reject) => {
            settle = () => (rejects ? reject(outcome) : resolve(outcome));
          }),
      );
      const request = vi.fn();
      const guard = vi.fn((event) => {
        if (event !== 'trusted') throw new Error('untrusted');
      });
      const deps = {
        ipcMain: {
          handle: (_channel: string, callback: typeof handler) => {
            handler = callback;
          },
        },
        authManager: { dispatchLoginAction: dispatch },
        authCredentialRecovery: { request },
        assertTrustedAppRendererEvent: guard,
      };
      new Function(...Object.keys(deps), compiled)(...Object.values(deps));
      await expect(handler('untrusted', { type: 'reset' })).rejects.toThrow('untrusted');
      expect(dispatch).not.toHaveBeenCalled();
      const action = { type: 'reset' };
      const pending = handler('trusted', action);
      expect(dispatch).toHaveBeenCalledWith(action);
      expect(request).not.toHaveBeenCalled();
      settle();
      if (rejects) await expect(pending).rejects.toBe(outcome);
      else await expect(pending).resolves.toBe(outcome);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('connects observed failures to recovery without probing the credential backend', () => {
    const wiring = bootstrap.match(
      /const authCredentialRecovery = createAuthCredentialRecovery\(\{([\s\S]*?)\n\}\);/,
    )?.[1];
    expect(wiring).toBeDefined();
    expect(wiring).toContain("enabled: process.platform === 'darwin' && app.isPackaged");
    expect(wiring).toContain('authManager.needsCredentialProcessRecovery()');
    expect(wiring).not.toContain('safeStorage');
    expect(wiring).toContain('authManager.isAuthFlowBusy()');
    expect(wiring).toContain('hasUpdateRelaunchBusyActivity');
    expect(wiring).toContain('evaluateRelaunchBusyActivity(readRelaunchActivitySources())');
    expect(wiring).toContain('app.relaunch({ args })');
    expect(wiring).toContain('app.quit()');
  });

  it.each([false, true])(
    'requests recovery when initialization rejects=%s without replacing its outcome',
    async (rejects) => {
      const start = bootstrap.indexOf("ipcMain.handle('auth:initialize',");
      const end = bootstrap.indexOf("ipcMain.handle('auth:get-login-state',", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const compiled = transpileModule(bootstrap.slice(start, end), {
        compilerOptions: { target: ScriptTarget.ES2022 },
      }).outputText;
      let handler!: () => Promise<unknown>;
      const outcome = rejects ? new Error('owner teardown failed') : { isAuthenticated: false };
      const request = vi.fn();
      const deps = {
        ipcMain: {
          handle: (_channel: string, callback: typeof handler) => {
            handler = callback;
          },
        },
        authManager: {
          initialize: () => (rejects ? Promise.reject(outcome) : Promise.resolve(outcome)),
          ensureStableOwnerPostCommitTasks: vi.fn(async () => {}),
        },
        authCredentialRecovery: { request },
        app: { isPackaged: true },
        noteAuthColdStartState: vi.fn(),
        isCindyVersionLaunchPending: () => false,
        recordDesktopDevAuthStartupResult: vi.fn(),
      };
      new Function(...Object.keys(deps), compiled)(...Object.values(deps));
      if (rejects) await expect(handler()).rejects.toBe(outcome);
      else await expect(handler()).resolves.toBe(outcome);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('requests recovery after resume, and removes screen listeners on quit', () => {
    expect(bootstrap).toMatch(
      /powerMonitor.on\('resume', \(\) => \{\s*authCredentialRecovery.request\(\)/,
    );
    for (const [event, handler] of [
      ['lock-screen', 'onScreenLock'],
      ['unlock-screen', 'onScreenUnlock'],
    ]) {
      expect(bootstrap).toContain(`powerMonitor.on('${event}', authCredentialRecovery.${handler})`);
      expect(bootstrap).toContain(
        `powerMonitor.removeListener('${event}', authCredentialRecovery.${handler})`,
      );
    }
    expect(bootstrap).toMatch(
      /onQuit\(\s*'auth-credential-recovery',\s*\(\) => \{\s*authCredentialRecovery.dispose\(\)/,
    );
  });
});
