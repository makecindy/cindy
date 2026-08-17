import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findChromeExecutableMac,
  resolveGoogleChromeExecutableForPlatform,
} from '../_generated/extension/src/browser/chrome.executables.js';

const stablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const bravePath = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const testHome = path.join(path.sep, 'Users', 'test');
const betaPaths = [
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  path.join(
    testHome,
    'Applications',
    'Google Chrome Beta.app',
    'Contents',
    'MacOS',
    'Google Chrome Beta',
  ),
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('macOS Chrome executable discovery', () => {
  it.each(betaPaths)('detects Chrome Beta at %s', (betaPath) => {
    vi.spyOn(os, 'homedir').mockReturnValue(testHome);
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (candidate) => String(candidate) === betaPath,
    );

    expect(findChromeExecutableMac()).toEqual({
      kind: 'chrome',
      path: betaPath,
    });
    expect(resolveGoogleChromeExecutableForPlatform('darwin')).toEqual({
      kind: 'chrome',
      path: betaPath,
    });
  });

  it('keeps stable Chrome ahead of Beta', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(testHome);
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      [stablePath, ...betaPaths].includes(String(candidate)),
    );

    expect(findChromeExecutableMac()).toEqual({ kind: 'chrome', path: stablePath });
    expect(resolveGoogleChromeExecutableForPlatform('darwin')).toEqual({
      kind: 'chrome',
      path: stablePath,
    });
  });

  it('keeps stable third-party browsers ahead of Beta', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(testHome);
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      [bravePath, ...betaPaths].includes(String(candidate)),
    );

    expect(findChromeExecutableMac()).toEqual({ kind: 'brave', path: bravePath });
    expect(resolveGoogleChromeExecutableForPlatform('darwin')).toEqual({
      kind: 'chrome',
      path: betaPaths[0],
    });
  });
});
