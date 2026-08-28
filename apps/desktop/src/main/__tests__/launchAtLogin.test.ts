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
  /**
   * 按 Windows 的实际语义建模:登录项以 args 为键存取,查询时传入的 args 必须与
   * 注册时一致才能命中。替身若忽略 args,就会把「查询漏传 args」这类缺陷一并测过。
   */
  function createApp(
    initial: boolean,
    /**
     * 模拟用户在任务管理器「启动应用」里停用 Cindy:注册表项仍在,但 run key
     * 被停用。Electron 用 executableWillLaunchAtLogin 反映这一点,且该字段忽略
     * args——所以它按可执行文件而非条目来记。
     */
    { runKeyDeactivated = false }: { runKeyDeactivated?: boolean } = {},
  ): LoginItemApp & { readArgs: (string[] | undefined)[]; writes: unknown[] } {
    const entries = new Map<string, boolean>();
    const key = (args?: string[]): string => JSON.stringify(args ?? []);
    if (initial) entries.set(key([OPENED_AT_LOGIN_FLAG]), true);
    const readArgs: (string[] | undefined)[] = [];
    const writes: unknown[] = [];
    return {
      readArgs,
      writes,
      getLoginItemSettings: (options) => {
        readArgs.push(options?.args);
        return {
          openAtLogin: entries.get(key(options?.args)) ?? false,
          // 忽略 args:只要该 exe 有任一登录项且未被停用就是 true。
          executableWillLaunchAtLogin: entries.size > 0 && !runKeyDeactivated,
        };
      },
      setLoginItemSettings: (settings) => {
        writes.push(settings);
        if (settings.openAtLogin) entries.set(key(settings.args), true);
        else entries.delete(key(settings.args));
      },
    };
  }

  it('reads the current login item state', () => {
    expect(readLaunchAtLogin(createApp(true))).toBe(true);
    expect(readLaunchAtLogin(createApp(false))).toBe(false);
  });

  // 回归:Windows 上 args 是「用于比对的参数」,缺省空数组。漏传会匹配不到我们
  // 注册的条目而恒返回 false,开关因此永远显示为关。
  it('queries with the same args used at registration', () => {
    const app = createApp(true);
    readLaunchAtLogin(app);
    expect(app.readArgs).toEqual([[OPENED_AT_LOGIN_FLAG]]);
  });

  // 回归:用户在任务管理器「启动应用」里停用 Cindy 后,注册表项还在、openAtLogin
  // 仍为 true,但开机不会启动。只读 openAtLogin 会把开关显示成开、并让「收起到
  // 托盘」保持可用,用户还无法靠再点一次开启把自启动恢复。
  it('reports off when the run key is deactivated in Task Manager', () => {
    const app = createApp(true, { runKeyDeactivated: true });
    // 条目确实还在。
    expect(app.getLoginItemSettings({ args: [OPENED_AT_LOGIN_FLAG] }).openAtLogin).toBe(true);
    // 但实际不会启动,所以对外必须报 false。
    expect(readLaunchAtLogin(app)).toBe(false);
  });

  // 非 Windows 的 Electron 不返回该字段,不能把 undefined 当成「已停用」。
  it('ignores the missing Windows-only field on other platforms', () => {
    const app: LoginItemApp = {
      getLoginItemSettings: () => ({ openAtLogin: true }),
      setLoginItemSettings: () => {},
    };
    expect(readLaunchAtLogin(app)).toBe(true);
  });

  it('does not find the entry when queried without matching args', () => {
    const app = createApp(true);
    // 模拟旧实现:不传 args。
    expect(app.getLoginItemSettings().openAtLogin).toBe(false);
    // 传对了才命中。
    expect(app.getLoginItemSettings({ args: [OPENED_AT_LOGIN_FLAG] }).openAtLogin).toBe(true);
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
    expect(app.writes).toEqual([
      { openAtLogin: true, args: [OPENED_AT_LOGIN_FLAG], enabled: true },
    ]);
  });

  // 关闭时漏传 args 会留下匹配不到的孤儿登录项,用户看起来"关不掉"。
  it('keeps passing the flag when disabling so Electron matches the existing entry', () => {
    const app = createApp(true);
    expect(writeLaunchAtLogin(app, false)).toBe(false);
    expect(app.writes).toEqual([
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

  it('round-trips through the same entry so a freshly enabled item reads back as on', () => {
    const app = createApp(false);
    expect(writeLaunchAtLogin(app, true)).toBe(true);
    // 关键联动:写入后立刻再查(设置页每次挂载都会查),必须仍是 true。
    expect(readLaunchAtLogin(app)).toBe(true);
    expect(writeLaunchAtLogin(app, false)).toBe(false);
    expect(readLaunchAtLogin(app)).toBe(false);
  });
});
