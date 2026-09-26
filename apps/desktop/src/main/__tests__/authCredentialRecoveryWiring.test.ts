import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const bootstrap = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');

describe('production credential recovery wiring', () => {
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

  it.each([
    { rejects: false, versionLaunchPending: false },
    { rejects: false, versionLaunchPending: true },
    { rejects: true, versionLaunchPending: false },
    { rejects: true, versionLaunchPending: true },
  ])(
    'requests recovery when initialization rejects=$rejects and versionLaunchPending=$versionLaunchPending without replacing its outcome',
    async ({ rejects, versionLaunchPending }) => {
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
      const recordStartupResult = vi.fn();
      const getAuthState = vi.fn(() => outcome);
      const deps = {
        ipcMain: {
          handle: (_channel: string, callback: typeof handler) => {
            handler = callback;
          },
        },
        authManager: {
          initialize: () => (rejects ? Promise.reject(outcome) : Promise.resolve(outcome)),
          ensureStableOwnerPostCommitTasks: vi.fn(async () => {}),
          getAuthState,
        },
        authCredentialRecovery: { request },
        app: { isPackaged: true },
        isCindyVersionLaunchPending: vi.fn(() => versionLaunchPending),
        recordDesktopDevAuthStartupResult: recordStartupResult,
        noteAuthColdStartState: vi.fn(),
      };
      new Function(...Object.keys(deps), compiled)(...Object.values(deps));
      if (rejects) await expect(handler()).rejects.toBe(outcome);
      else await expect(handler()).resolves.toBe(outcome);
      expect(request).toHaveBeenCalledTimes(1);
      if (!rejects && versionLaunchPending) {
        expect(recordStartupResult).toHaveBeenCalledExactlyOnceWith(
          outcome,
          null,
          expect.any(Function),
        );
        expect(recordStartupResult.mock.calls[0][2]()).toBe(outcome);
        expect(getAuthState).toHaveBeenCalledTimes(1);
      } else {
        expect(recordStartupResult).not.toHaveBeenCalled();
        expect(getAuthState).not.toHaveBeenCalled();
      }
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
