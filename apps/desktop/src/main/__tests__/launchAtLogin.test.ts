import { describe, expect, it, vi } from 'vitest';

import {
  OPENED_AT_LOGIN_FLAG,
  readLaunchAtLogin,
  shouldStartHiddenInTray,
  wasOpenedAtLogin,
  writeLaunchAtLogin,
  type LoginItemApp,
} from '../launchAtLogin';

function trayAlwaysReady(): () => boolean {
  return vi.fn(() => true);
}

describe('wasOpenedAtLogin', () => {
  it('detects the login-item flag anywhere in argv', () => {
    expect(wasOpenedAtLogin(['Cindy.exe', OPENED_AT_LOGIN_FLAG])).toBe(true);
    expect(wasOpenedAtLogin([OPENED_AT_LOGIN_FLAG, '--other'])).toBe(true);
  });

  it('reports a manual launch when the flag is absent', () => {
    expect(wasOpenedAtLogin(['Cindy.exe'])).toBe(false);
    expect(wasOpenedAtLogin([])).toBe(false);
  });

  it('does not match a partial or suffixed argument', () => {
    expect(wasOpenedAtLogin(['--opened-at-login=1'])).toBe(false);
    expect(wasOpenedAtLogin(['--opened-at-logins'])).toBe(false);
  });
});

describe('shouldStartHiddenInTray', () => {
  const base = {
    platform: 'win32' as NodeJS.Platform,
    argv: ['Cindy.exe', OPENED_AT_LOGIN_FLAG],
    startInTrayOnLogin: true,
  };

  it('hides only when every condition holds', () => {
    expect(shouldStartHiddenInTray({ ...base, ensureTray: trayAlwaysReady() })).toBe(true);
  });

  it('shows the window when the setting is off', () => {
    expect(
      shouldStartHiddenInTray({
        ...base,
        startInTrayOnLogin: false,
        ensureTray: trayAlwaysReady(),
      }),
    ).toBe(false);
  });

  it('shows the window on a manual launch even with the setting on', () => {
    expect(
      shouldStartHiddenInTray({ ...base, argv: ['Cindy.exe'], ensureTray: trayAlwaysReady() }),
    ).toBe(false);
  });

  it.each(['darwin', 'linux'] as const)('never hides on %s', (platform) => {
    expect(
      shouldStartHiddenInTray({ ...base, platform, ensureTray: trayAlwaysReady() }),
    ).toBe(false);
  });

  // 这条是安全边界:托盘建不出来还隐藏窗口,用户就只剩任务管理器可用了。
  it('falls back to showing the window when the tray icon cannot be created', () => {
    expect(shouldStartHiddenInTray({ ...base, ensureTray: () => false })).toBe(false);
  });

  it('does not create a tray icon when an earlier condition already rules out hiding', () => {
    const ensureTray = vi.fn(() => true);
    shouldStartHiddenInTray({ ...base, startInTrayOnLogin: false, ensureTray });
    shouldStartHiddenInTray({ ...base, argv: ['Cindy.exe'], ensureTray });
    shouldStartHiddenInTray({ ...base, platform: 'darwin', ensureTray });
    expect(ensureTray).not.toHaveBeenCalled();
  });
});

describe('login item read/write', () => {
  function createApp(initial: boolean): LoginItemApp & { calls: unknown[] } {
    let openAtLogin = initial;
    const calls: unknown[] = [];
    return {
      calls,
      getLoginItemSettings: () => ({ openAtLogin }),
      setLoginItemSettings: (settings) => {
        calls.push(settings);
        openAtLogin = settings.openAtLogin;
      },
    };
  }

  it('reads the current login item state', () => {
    expect(readLaunchAtLogin(createApp(true))).toBe(true);
    expect(readLaunchAtLogin(createApp(false))).toBe(false);
  });

  it('treats a failing query as not enabled', () => {
    const app: LoginItemApp = {
      getLoginItemSettings: () => {
        throw new Error('registry unavailable');
      },
      setLoginItemSettings: () => {},
    };
    expect(readLaunchAtLogin(app)).toBe(false);
  });

  it('registers the login item with the flag so startup can be recognised', () => {
    const app = createApp(false);
    expect(writeLaunchAtLogin(app, true)).toBe(true);
    expect(app.calls).toEqual([
      { openAtLogin: true, args: [OPENED_AT_LOGIN_FLAG], enabled: true },
    ]);
  });

  // 关闭时漏传 args 会留下匹配不到的孤儿登录项,用户看起来"关不掉"。
  it('keeps passing the flag when disabling so Electron matches the existing entry', () => {
    const app = createApp(true);
    expect(writeLaunchAtLogin(app, false)).toBe(false);
    expect(app.calls).toEqual([
      { openAtLogin: false, args: [OPENED_AT_LOGIN_FLAG], enabled: false },
    ]);
  });

  it('reports the real state when the write does not take effect', () => {
    const app: LoginItemApp = {
      // 无权限改登录项:写入被系统忽略,查询仍返回旧值。
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: () => {},
    };
    expect(writeLaunchAtLogin(app, true)).toBe(false);
  });
});
