import { describe, expect, it } from 'vitest';

import {
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
    expect(parseDefaultHandler('win32', '    ProgId    REG_SZ    FirefoxURL-308046B0AF4A39CB')).toBe(
      'other',
    );
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
    expect(resolveSourceBrowser({ defaultKind: 'other', installed: [edge, chrome] })).toEqual(chrome);
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

describe('userDataDirFor', () => {
  it('resolves Chromium user-data directories with the target OS separators', () => {
    expect(userDataDirFor('chrome', 'darwin', '/Users/dash')).toBe(
      '/Users/dash/Library/Application Support/Google/Chrome',
    );
    expect(userDataDirFor('chrome', 'linux', '/home/dash')).toBe('/home/dash/.config/google-chrome');
    expect(
      userDataDirFor('chrome', 'win32', 'C:\\Users\\dash', {
        LOCALAPPDATA: 'C:\\Users\\dash\\AppData\\Local',
      }),
    ).toBe('C:\\Users\\dash\\AppData\\Local\\Google\\Chrome\\User Data');
  });
});
