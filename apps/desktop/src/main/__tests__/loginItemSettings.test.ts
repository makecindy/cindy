import type { App, LoginItemSettings, Settings } from 'electron';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createLoginItemSettings } from '../login-item-settings.js';

function fixture(platform: NodeJS.Platform = 'win32', isPackaged = true, executable?: string) {
  const execPath =
    executable ?? (platform === 'win32'
      ? path.win32.join('C:', 'Program Files', 'Cindy', 'Cindy.exe')
      : '/Applications/Cindy.app/Contents/MacOS/Cindy');
  let native: LoginItemSettings = {
    openAtLogin: false,
    openAsHidden: false,
    wasOpenedAtLogin: false,
    wasOpenedAsHidden: false,
    restoreState: false,
    status: 'not-registered',
    executableWillLaunchAtLogin: false,
    launchItems: [],
  };
  const app = {
    isPackaged,
    getLoginItemSettings: vi.fn((options: Parameters<App['getLoginItemSettings']>[0]) => {
      if (platform !== 'win32') return native;
      // Electron 41 parses the lookup as a command line, not as a raw path.
      const lookup = options?.path ?? execPath;
      const program = lookup.startsWith('"') ? lookup.split('"')[1] : lookup.split(' ')[0];
      const launchItems = native.launchItems.filter(
        (item) => item.path.toLowerCase() === program.toLowerCase(),
      );
      return {
        ...native,
        launchItems,
        executableWillLaunchAtLogin: launchItems.some((item) => item.enabled),
      };
    }),
    setLoginItemSettings: vi.fn((settings: Settings) => {
      native = {
        ...native,
        // On Windows openAtLogin reads only the AppUserModelID entry, not Cindy.
        openAtLogin: platform !== 'win32' && settings.openAtLogin === true,
        executableWillLaunchAtLogin: settings.openAtLogin === true,
        status: settings.openAtLogin ? 'enabled' : 'not-registered',
        launchItems: settings.openAtLogin
          ? [{ name: 'Cindy', path: execPath, args: [], scope: 'user', enabled: true }]
          : [],
      };
    }),
  };
  return {
    app,
    execPath,
    service: createLoginItemSettings({ app, platform, execPath }),
    changeNative: (patch: Partial<LoginItemSettings>) => {
      native = { ...native, ...patch };
    },
  };
}

describe('native login startup preference', () => {
  it.each(['win32', 'darwin'] as const)(
    'defaults off on %s without writing on construction or read',
    (platform) => {
      const { service, app } = fixture(platform);
      expect(service.read()).toEqual({ available: true, enabled: false, requiresApproval: false });
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    },
  );

  it('registers and removes the stable Windows executable with matching arguments', () => {
    const { service, app, execPath } = fixture();
    expect(service.set(true).enabled).toBe(true);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({
      path: execPath,
      args: [],
      name: 'Cindy',
      openAtLogin: true,
      enabled: true,
    });
    expect(app.getLoginItemSettings).toHaveBeenLastCalledWith({ path: `"${execPath}"`, args: [] });
    expect(service.set(false).enabled).toBe(false);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({
      path: execPath,
      args: [],
      name: 'Cindy',
      openAtLogin: false,
      enabled: false,
    });
  });

  it.each([
    path.win32.join('C:', 'Cindy', 'Cindy.exe'),
    path.win32.join('C:', 'Program Files', 'Cindy', 'Cindy.exe'),
    path.win32.join('C:', 'Users', 'Test User', 'AppData', 'Local', 'Cindy', 'Cindy.exe'),
  ])('reads the named Windows entry independently of openAtLogin at %s', (execPath) => {
    const { service, app } = fixture('win32', true, execPath);
    expect(service.set(true).enabled).toBe(true);
    expect(app.getLoginItemSettings({ path: `"${execPath}"` }).openAtLogin).toBe(false);
    expect(service.read().enabled).toBe(true);
    expect(service.set(false).enabled).toBe(false);
    expect(service.read().enabled).toBe(false);
  });

  it('ignores other Windows entry names, scopes and arguments', () => {
    const { service, execPath, changeNative } = fixture();
    changeNative({
      openAtLogin: true,
      launchItems: [
        { name: 'Other entry', path: execPath, args: [], scope: 'user', enabled: true },
        { name: 'Cindy', path: execPath, args: [], scope: 'machine', enabled: true },
        { name: 'Cindy', path: execPath, args: ['--other'], scope: 'user', enabled: true },
      ],
    });
    expect(service.read().enabled).toBe(false);
  });

  it('uses the native main app login service on macOS', () => {
    const { service, app } = fixture('darwin');
    expect(service.set(true).enabled).toBe(true);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true });
    expect(service.set(false).enabled).toBe(false);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
  });

  it('reflects Task Manager disabling our entry even if another entry launches the executable', () => {
    const { service, app, execPath, changeNative } = fixture();
    service.set(true);
    changeNative({
      executableWillLaunchAtLogin: true,
      launchItems: [
        { name: 'Cindy', path: execPath, args: [], scope: 'user', enabled: false },
        { name: 'Other entry', path: execPath, args: ['--other'], scope: 'user', enabled: true },
      ],
    });
    expect(service.read().enabled).toBe(false);
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1);
    expect(service.set(true).enabled).toBe(true);
  });

  it('reflects removal in macOS System Settings without restoring the item', () => {
    const { service, app, changeNative } = fixture('darwin');
    service.set(true);
    changeNative({ openAtLogin: false, status: 'not-registered' });
    expect(service.read().enabled).toBe(false);
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1);
  });

  it('reports pending macOS approval and allows cancelling it', () => {
    const { service, app, changeNative } = fixture('darwin');
    app.setLoginItemSettings.mockImplementationOnce(() => {
      changeNative({ openAtLogin: false, status: 'requires-approval' });
    });
    expect(service.set(true)).toEqual({ available: true, enabled: false, requiresApproval: true });
    expect(service.set(false).requiresApproval).toBe(false);
  });

  it.each([
    ['win32', false],
    ['darwin', false],
    ['linux', true],
  ] as const)(
    'rejects unsupported environment %s packaged=%s before OS access',
    (platform, packaged) => {
      const { service, app } = fixture(platform, packaged);
      expect(service.read().available).toBe(false);
      expect(() => service.set(true)).toThrow('[UNSUPPORTED_CAPABILITY]');
      expect(app.getLoginItemSettings).not.toHaveBeenCalled();
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    },
  );

  it.each([null, undefined, 1, 'true', {}, []])(
    'rejects non-boolean input %j before OS access',
    (input) => {
      const { service, app } = fixture();
      expect(() => service.set(input)).toThrow('[INVALID_PARAMS]');
      expect(app.getLoginItemSettings).not.toHaveBeenCalled();
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    },
  );

  it('reports silent system refusal instead of claiming the setting was saved', () => {
    const { service, app } = fixture();
    app.setLoginItemSettings.mockImplementation(() => undefined);
    expect(() => service.set(true)).toThrow('[PRECONDITION_FAILED]');
  });

  it('sanitizes native read and write errors', () => {
    const { service, app } = fixture();
    app.getLoginItemSettings.mockImplementationOnce(() => {
      throw new Error('private path');
    });
    expect(() => service.read()).toThrow('[INTERNAL] Unable to read login startup settings');
    app.setLoginItemSettings.mockImplementationOnce(() => {
      throw new Error('private path');
    });
    expect(() => service.set(true)).toThrow('[INTERNAL] Unable to update login startup settings');
  });
});
