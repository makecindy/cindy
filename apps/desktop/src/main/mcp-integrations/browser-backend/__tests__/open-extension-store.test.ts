import { describe, expect, it, vi } from 'vitest';

import { RECOMMENDED_PAGE_CONTROL_EXTENSION_STORE_URL } from '../../../../shared/browserBackend.js';
import { RealProfileError } from '../../browser-real-profile/types.js';
import { openExtensionStoreInUserBrowser, startUserBrowser } from '../open-extension-store.js';

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


describe('startUserBrowser', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('starts the normal browser without a URL or profile override on %s', async platform => {
    const launch = vi.fn(async () => undefined);
    const executablePath = platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/browser/chrome';
    await startUserBrowser({ platform, launch, resolveBrowser: () => ({ kind: 'chrome', executablePath, userDataDir: '/private/profile' }) });
    expect(launch).toHaveBeenCalledWith(platform === 'darwin' ? '/usr/bin/open' : executablePath,
      platform === 'darwin' ? ['-g', '-n', '-a', '/Applications/Google Chrome.app', '--args', '--start-minimized'] : ['--start-minimized']);
  });
  it('reports launch failure instead of claiming the extension connected', async () => {
    await expect(startUserBrowser({ platform: 'linux', resolveBrowser: () => ({ kind: 'chrome', executablePath: '/chrome', userDataDir: '/u' }), launch: async () => { throw Error('ENOENT'); } })).rejects.toThrow('未能启动浏览器');
  });
});
