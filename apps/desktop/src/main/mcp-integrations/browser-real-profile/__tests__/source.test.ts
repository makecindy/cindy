import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  listInstalledChromium,
  parseDefaultHandler,
  resolveSourceBrowser,
  userDataDirFor,
} from '../source.js';
import { RealProfileError, type InstalledChromium } from '../types.js';

const chrome: InstalledChromium = {
  kind: 'chrome',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  userDataDir: '/Users/x/Library/Application Support/Google/Chrome',
};
const edge: InstalledChromium = {
  kind: 'edge',
  executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  userDataDir: '/Users/x/Library/Application Support/Microsoft Edge',
};

describe('parseDefaultHandler', () => {
  it('reads the last https handler from a LaunchServices dump', () => {
    const raw = `
    {
        LSHandlerRoleAll = "com.apple.Safari";
        LSHandlerURLScheme = https;
    }
    {
        LSHandlerRoleAll = "com.google.Chrome";
        LSHandlerURLScheme = https;
    }
    `;
    expect(parseDefaultHandler('darwin', raw)).toBe('chrome');
  });

  it('treats Safari and Firefox as other so Chrome can still be selected', () => {
    expect(parseDefaultHandler('darwin', 'com.apple.Safari')).toBe('other');
    expect(parseDefaultHandler('linux', 'firefox.desktop')).toBe('other');
    expect(
      parseDefaultHandler('win32', '    ProgId    REG_SZ    FirefoxURL-308046B0AF4A39CB'),
    ).toBe('other');
  });

  it('maps Edge / Brave / Chrome progids and desktop files', () => {
    expect(parseDefaultHandler('win32', 'ProgId    REG_SZ    ChromeHTML')).toBe('chrome');
    expect(parseDefaultHandler('win32', 'ProgId    REG_SZ    MSEdgeHTM')).toBe('edge');
    expect(parseDefaultHandler('linux', 'brave-browser.desktop')).toBe('brave');
  });

  it('treats beta/canary channels as other', () => {
    expect(parseDefaultHandler('darwin', 'com.google.Chrome.canary')).toBe('other');
    expect(parseDefaultHandler('linux', 'google-chrome-beta.desktop')).toBe('other');
  });
});

describe('resolveSourceBrowser', () => {
  it('uses the default Chromium-family browser when it is installed', () => {
    expect(resolveSourceBrowser({ defaultKind: 'edge', installed: [chrome, edge] })).toEqual(edge);
  });

  it('falls back to Chrome when the OS default is Safari', () => {
    expect(resolveSourceBrowser({ defaultKind: 'other', installed: [edge, chrome] })).toEqual(
      chrome,
    );
  });

  it('falls back to Chrome when default detection fails', () => {
    expect(resolveSourceBrowser({ defaultKind: null, installed: [edge, chrome] })).toEqual(chrome);
  });

  it('uses Edge when Chrome is not installed', () => {
    expect(resolveSourceBrowser({ defaultKind: 'other', installed: [edge] })).toEqual(edge);
  });

  it('fails closed when no Chromium-family browser is installed', () => {
    expect(() => resolveSourceBrowser({ defaultKind: 'other', installed: [] })).toThrow(
      RealProfileError,
    );
  });
});

describe('listInstalledChromium', () => {
  it('finds Chrome under the user Applications folder on darwin', () => {
    const home = '/Users/x';
    const exe = `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
    expect(
      listInstalledChromium({
        platform: 'darwin',
        home,
        exists: (filePath) => filePath === exe,
      }),
    ).toEqual([
      {
        kind: 'chrome',
        executablePath: exe,
        userDataDir: `${home}/Library/Application Support/Google/Chrome`,
      },
    ]);
  });

  it('finds Snap Brave / Chromium / Chrome and maps their profile dirs', () => {
    const home = '/home/x';
    const brave = '/snap/bin/brave';
    const chromium = '/snap/bin/chromium';
    const chromeSnap = '/snap/bin/google-chrome';
    expect(
      listInstalledChromium({
        platform: 'linux',
        home,
        exists: (filePath) =>
          filePath === brave || filePath === chromium || filePath === chromeSnap,
      }),
    ).toEqual([
      {
        kind: 'chrome',
        executablePath: chromeSnap,
        userDataDir: `${home}/snap/google-chrome/current/.config/google-chrome`,
      },
      {
        kind: 'brave',
        executablePath: brave,
        userDataDir: `${home}/snap/brave/current/.config/BraveSoftware/Brave-Browser`,
      },
      {
        kind: 'chromium',
        executablePath: chromium,
        userDataDir: `${home}/snap/chromium/common/chromium`,
      },
    ]);
  });

  it('prefers distro Chrome over Snap and keeps ~/.config user-data', () => {
    const home = '/home/x';
    const distro = '/usr/bin/google-chrome-stable';
    const snap = '/snap/bin/google-chrome';
    expect(
      listInstalledChromium({
        platform: 'linux',
        home,
        exists: (filePath) => filePath === distro || filePath === snap,
      }),
    ).toEqual([
      {
        kind: 'chrome',
        executablePath: distro,
        userDataDir: `${home}/.config/google-chrome`,
      },
    ]);
  });

  it('finds Edge under LOCALAPPDATA on win32', () => {
    const home = 'C:\\Users\\x';
    const local = 'C:\\Users\\x\\AppData\\Local';
    const exe = path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    expect(
      listInstalledChromium({
        platform: 'win32',
        home,
        env: {
          LOCALAPPDATA: local,
          PROGRAMFILES: 'C:\\Program Files',
          'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
        },
        exists: (filePath) => filePath === exe,
      }),
    ).toEqual([
      {
        kind: 'edge',
        executablePath: exe,
        userDataDir: path.win32.join(local, 'Microsoft', 'Edge', 'User Data'),
      },
    ]);
  });
});

describe('userDataDirFor', () => {
  it('resolves Chromium user-data directories with the target OS separators', () => {
    expect(userDataDirFor('chrome', 'darwin', '/Users/dash')).toBe(
      '/Users/dash/Library/Application Support/Google/Chrome',
    );
    expect(userDataDirFor('chrome', 'linux', '/home/dash')).toBe(
      '/home/dash/.config/google-chrome',
    );
    expect(
      userDataDirFor('chrome', 'win32', 'C:\\Users\\dash', {
        LOCALAPPDATA: 'C:\\Users\\dash\\AppData\\Local',
      }),
    ).toBe('C:\\Users\\dash\\AppData\\Local\\Google\\Chrome\\User Data');
    expect(userDataDirFor('brave', 'linux', '/home/dash', {}, '/snap/bin/brave')).toBe(
      '/home/dash/snap/brave/current/.config/BraveSoftware/Brave-Browser',
    );
    expect(userDataDirFor('brave', 'linux', '/home/dash', {}, '/usr/bin/brave')).toBe(
      '/home/dash/.config/BraveSoftware/Brave-Browser',
    );
  });
});
