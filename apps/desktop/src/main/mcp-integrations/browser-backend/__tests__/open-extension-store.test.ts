import { describe, expect, it, vi } from 'vitest';

import { RECOMMENDED_PAGE_CONTROL_EXTENSION_STORE_URL } from '../../../../shared/browserBackend.js';
import { RealProfileError } from '../../browser-real-profile/types.js';
import {
  classifyChromiumProcessEntries,
  classifyChromiumProcesses,
  inspectUserBrowserProcesses,
  isUserBrowserRunning,
  openExtensionStoreInUserBrowser,
  startUserBrowser,
} from '../open-extension-store.js';

// Settings installs the My browser extension from the store page opened in the user's own
// browser, instead of sending them to the plugin page first.
describe('openExtensionStoreInUserBrowser', () => {
  it('opens the store page in the running macOS browser app', async () => {
    const launch = vi.fn(async () => undefined);
    const result = await openExtensionStoreInUserBrowser({
      platform: 'darwin',
      resolveBrowser: () => ({
        kind: 'edge',
        executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        userDataDir: '/u',
      }),
      launch,
    });
    expect(result).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledWith('/usr/bin/open', [
      '-a',
      '/Applications/Microsoft Edge.app',
      RECOMMENDED_PAGE_CONTROL_EXTENSION_STORE_URL,
    ]);
  });

  it('reports a missing browser so Settings can fall back to the plugin page', async () => {
    const launch = vi.fn();
    const result = await openExtensionStoreInUserBrowser({
      platform: 'win32',
      resolveBrowser: () => {
        throw new RealProfileError('NO_CHROMIUM', 'none');
      },
      launch,
    });
    expect(result).toEqual({ ok: false, error: 'NO_CHROMIUM' });
    expect(launch).not.toHaveBeenCalled();
  });
});

// Regression (P0-1): macOS previously passed `-n --args --start-minimized` unconditionally,
// colliding with an already-running normal Chrome profile (ProcessSingleton crash / Dock flash)
// and sending a Windows-only flag on macOS.
// Production entries: classifyChromiumProcesses / isUserBrowserRunning / startUserBrowser (unit tier).
describe('classifyChromiumProcesses', () => {
  it('distinguishes normal macOS Chrome from Cindy dedicated-profile Chrome and helpers', () => {
    const browser = {
      kind: 'chrome' as const,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      userDataDir: '/Users/alice/Library/Application Support/Google/Chrome',
    };
    // Only Cindy's dedicated external browser + helper processes running: normal profile is NOT running.
    expect(
      classifyChromiumProcesses(
        [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/alice/Library/Application Support/Cindy/browser-runtime/Cindy --remote-debugging-port=18800',
          '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer',
        ],
        browser,
        'darwin',
      ),
    ).toEqual({ normalRunning: false, customProfileRunning: true });

    // Normal Chrome without --user-data-dir (or explicitly pointing to default dir) is detected.
    expect(
      classifyChromiumProcesses(
        ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --flag-switches-begin'],
        browser,
        'darwin',
      ),
    ).toEqual({ normalRunning: true, customProfileRunning: false });

    expect(
      classifyChromiumProcesses(
        [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/alice/Library/Application Support/Google/Chrome --no-first-run',
        ],
        browser,
        'darwin',
      ),
    ).toEqual({ normalRunning: true, customProfileRunning: false });
  });

  it('classifies Windows Chrome processes case-insensitively and ignores child processes', () => {
    const browser = {
      kind: 'chrome' as const,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      userDataDir: 'C:\\Users\\Alice\\AppData\\Local\\Google\\Chrome\\User Data',
    };
    expect(
      classifyChromiumProcesses(
        [
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=gpu-process',
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="C:\\Users\\Alice\\AppData\\Roaming\\Cindy\\browser-runtime\\Cindy"',
        ],
        browser,
        'win32',
      ),
    ).toEqual({ normalRunning: false, customProfileRunning: true });

    expect(
      classifyChromiumProcesses(
        ['"c:\\program files\\google\\chrome\\application\\chrome.exe" --profile-directory=Default'],
        browser,
        'win32',
      ),
    ).toEqual({ normalRunning: true, customProfileRunning: false });
  });

  it('matches Linux wrapper executables against unwrapped browser binaries', () => {
    const browser = {
      kind: 'chrome' as const,
      executablePath: '/usr/bin/google-chrome-stable',
      userDataDir: '/home/alice/.config/google-chrome',
    };
    expect(
      classifyChromiumProcesses(['/opt/google/chrome/chrome --enable-crashpad'], browser, 'linux'),
    ).toEqual({ normalRunning: true, customProfileRunning: false });
  });
});

describe('startUserBrowser', () => {
  it.each(['darwin', 'win32', 'linux'] as const)(
    'starts the normal browser cleanly when not running on %s',
    async (platform) => {
      const launch = vi.fn(async () => undefined);
      const executablePath =
        platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : '/browser/chrome';
      await startUserBrowser({
        platform,
        launch,
        inspectProcesses: async () => ({ normalRunning: false, customProfileRunning: false }),
        resolveBrowser: () => ({ kind: 'chrome', executablePath, userDataDir: '/private/profile' }),
      });
      expect(launch).toHaveBeenCalledWith(
        platform === 'darwin' ? '/usr/bin/open' : executablePath,
        platform === 'darwin'
          ? ['-g', '-a', '/Applications/Google Chrome.app']
          : ['--start-minimized'],
      );
    },
  );

  it('uses -n on macOS without --start-minimized only when a dedicated-profile instance is running and normal profile is not', async () => {
    const launch = vi.fn(async () => undefined);
    await startUserBrowser({
      platform: 'darwin',
      launch,
      inspectProcesses: async () => ({ normalRunning: false, customProfileRunning: true }),
      resolveBrowser: () => ({
        kind: 'chrome',
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        userDataDir: '/Users/alice/Library/Application Support/Google/Chrome',
      }),
    });
    expect(launch).toHaveBeenCalledWith('/usr/bin/open', [
      '-g',
      '-n',
      '-a',
      '/Applications/Google Chrome.app',
    ]);
  });

  it('skips launching when the normal-profile browser is already running with a window or unknown window state', async () => {
    const launch = vi.fn(async () => undefined);
    const resolveBrowser = () => ({
      kind: 'chrome' as const,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      userDataDir: '/Users/alice/Library/Application Support/Google/Chrome',
    });
    for (const hasWindow of [undefined, true] as const) {
      await startUserBrowser({
        platform: 'darwin',
        launch,
        inspectProcesses: async () => ({ normalRunning: true, customProfileRunning: false, hasWindow }),
        resolveBrowser,
      });
    }
    expect(launch).not.toHaveBeenCalled();
  });

  // Regression: macOS keeps Chrome alive in the Dock at 0 windows while Chromium's
  // DestroyProfileOnBrowserClose unloads the Profile & all extensions. Reopening with
  // `open -g -a` (without `-n`) wakes the Profile safely without a ProcessSingleton collision.
  it('wakes a macOS 0-window normal browser with open -g -a and never passes -n', async () => {
    const launch = vi.fn(async () => undefined);
    const resolveBrowser = () => ({
      kind: 'chrome' as const,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      userDataDir: '/Users/alice/Library/Application Support/Google/Chrome',
    });
    await startUserBrowser({
      platform: 'darwin',
      launch,
      inspectProcesses: async () => ({
        normalRunning: true,
        customProfileRunning: true,
        normalPids: [1672],
        hasWindow: false,
      }),
      resolveBrowser,
    });
    expect(launch).toHaveBeenCalledWith('/usr/bin/open', [
      '-g',
      '-a',
      '/Applications/Google Chrome.app',
    ]);
  });

  it('extracts normal browser PIDs and probes macOS window state via inspectUserBrowserProcesses', async () => {
    const browser = {
      kind: 'chrome' as const,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      userDataDir: '/Users/alice/Library/Application Support/Google/Chrome',
    };
    expect(
      classifyChromiumProcessEntries(
        [
          { pid: 1672, commandLine: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
          { pid: 1673, commandLine: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer' },
          {
            pid: 2001,
            commandLine:
              '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/alice/Library/Application Support/Cindy/browser-runtime/Cindy',
          },
        ],
        browser,
        'darwin',
      ),
    ).toEqual({ normalRunning: true, customProfileRunning: true, normalPids: [1672] });

    const hasBrowserWindow = vi.fn(async () => false);
    const macState = await inspectUserBrowserProcesses({
      platform: 'darwin',
      resolveBrowser: () => browser,
      listProcesses: async () => [
        { pid: 1672, commandLine: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      ],
      hasBrowserWindow,
    });
    expect(hasBrowserWindow).toHaveBeenCalledWith([1672], browser, 'darwin');
    expect(macState).toEqual({
      normalRunning: true,
      customProfileRunning: false,
      normalPids: [1672],
      hasWindow: false,
    });

    // On non-macOS platforms, window probing is skipped and hasWindow stays undefined.
    const winProbe = vi.fn(async () => false);
    const winState = await inspectUserBrowserProcesses({
      platform: 'win32',
      resolveBrowser: () => ({
        kind: 'chrome',
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        userDataDir: 'C:\\Users\\Alice\\AppData\\Local\\Google\\Chrome\\User Data',
      }),
      listProcesses: async () => [
        { pid: 4000, commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"' },
      ],
      hasBrowserWindow: winProbe,
    });
    expect(winProbe).not.toHaveBeenCalled();
    expect(winState.hasWindow).toBeUndefined();
  });

  it('reports running state via isUserBrowserRunning without throwing when no browser is installed', async () => {
    expect(
      await isUserBrowserRunning({
        platform: 'darwin',
        resolveBrowser: () => {
          throw new RealProfileError('NO_CHROMIUM', 'none');
        },
      }),
    ).toBe(false);
    expect(
      await isUserBrowserRunning({
        platform: 'darwin',
        resolveBrowser: () => ({
          kind: 'chrome',
          executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          userDataDir: '/Users/alice/Library/Application Support/Google/Chrome',
        }),
        listProcessCommandLines: async () => [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ],
      }),
    ).toBe(true);
  });

  it('reports launch failure instead of claiming the extension connected', async () => {
    await expect(
      startUserBrowser({
        platform: 'linux',
        inspectProcesses: async () => ({ normalRunning: false, customProfileRunning: false }),
        resolveBrowser: () => ({ kind: 'chrome', executablePath: '/chrome', userDataDir: '/u' }),
        launch: async () => {
          throw Error('ENOENT');
        },
      }),
    ).rejects.toThrow('未能启动浏览器');
  });
});
