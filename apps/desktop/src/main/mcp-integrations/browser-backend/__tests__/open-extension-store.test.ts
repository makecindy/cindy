import { describe, expect, it, vi } from 'vitest';

import { RECOMMENDED_PAGE_CONTROL_EXTENSION_STORE_URL } from '../../../../shared/browserBackend.js';
import { RealProfileError } from '../../browser-real-profile/types.js';
import {
  classifyChromiumProcesses,
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

  it('skips launching when the normal-profile browser is already running', async () => {
    const launch = vi.fn(async () => undefined);
    await startUserBrowser({
      platform: 'darwin',
      launch,
      inspectProcesses: async () => ({ normalRunning: true, customProfileRunning: false }),
      resolveBrowser: () => ({
        kind: 'chrome',
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        userDataDir: '/Users/alice/Library/Application Support/Google/Chrome',
      }),
    });
    expect(launch).not.toHaveBeenCalled();
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
