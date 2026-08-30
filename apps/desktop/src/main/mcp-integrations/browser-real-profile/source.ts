import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  CHROMIUM_KINDS,
  RealProfileError,
  type ChromiumKind,
  type DefaultBrowserKind,
  type InstalledChromium,
} from './types.js';

const BUNDLE_ID_TO_KIND: Record<string, ChromiumKind | 'other'> = {
  'com.google.chrome': 'chrome',
  'com.google.chrome.canary': 'other',
  'com.google.chrome.beta': 'other',
  'com.google.chrome.dev': 'other',
  'com.microsoft.edgemac': 'edge',
  'com.microsoft.edgemac.beta': 'other',
  'com.microsoft.edgemac.dev': 'other',
  'com.microsoft.edgemac.canary': 'other',
  'com.brave.browser': 'brave',
  'com.brave.browser.beta': 'other',
  'com.brave.browser.nightly': 'other',
  'org.chromium.chromium': 'chromium',
  'com.apple.safari': 'other',
  'org.mozilla.firefox': 'other',
};

const PROGID_TO_KIND: Record<string, ChromiumKind | 'other'> = {
  chromehtml: 'chrome',
  chromebhtml: 'other',
  chromedhtml: 'other',
  msedgehtm: 'edge',
  msedgebhtm: 'other',
  bravehtml: 'brave',
  firefoxurl: 'other',
  firefoxhtml: 'other',
};

const DESKTOP_TO_KIND: Record<string, ChromiumKind | 'other'> = {
  'google-chrome.desktop': 'chrome',
  'google-chrome-stable.desktop': 'chrome',
  'google-chrome-beta.desktop': 'other',
  'microsoft-edge.desktop': 'edge',
  'microsoft-edge-stable.desktop': 'edge',
  'brave-browser.desktop': 'brave',
  'chromium-browser.desktop': 'chromium',
  'chromium.desktop': 'chromium',
  'firefox.desktop': 'other',
  'org.mozilla.firefox.desktop': 'other',
};

function pathFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function snapUserDataDir(
  kind: ChromiumKind,
  home: string,
  executablePath: string | undefined,
): string | null {
  if (!executablePath?.startsWith('/snap/bin/')) return null;
  const binary = executablePath.slice('/snap/bin/'.length);
  if (!binary || binary.includes('/')) return null;
  const osPath = path.posix;
  switch (kind) {
    case 'chrome':
      if (binary !== 'google-chrome' && binary !== 'chrome') return null;
      return osPath.join(home, 'snap', 'google-chrome', 'current', '.config', 'google-chrome');
    case 'brave':
      if (binary !== 'brave') return null;
      return osPath.join(
        home,
        'snap',
        'brave',
        'current',
        '.config',
        'BraveSoftware',
        'Brave-Browser',
      );
    case 'chromium':
      if (binary !== 'chromium') return null;
      return osPath.join(home, 'snap', 'chromium', 'common', 'chromium');
    case 'edge':
      return null;
  }
}

export function userDataDirFor(
  kind: ChromiumKind,
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  executablePath?: string,
): string {
  const snapDir = snapUserDataDir(kind, home, executablePath);
  if (snapDir) return snapDir;
  const osPath = pathFor(platform);
  if (platform === 'darwin') {
    const support = osPath.join(home, 'Library', 'Application Support');
    switch (kind) {
      case 'chrome':
        return osPath.join(support, 'Google', 'Chrome');
      case 'edge':
        return osPath.join(support, 'Microsoft Edge');
      case 'brave':
        return osPath.join(support, 'BraveSoftware', 'Brave-Browser');
      case 'chromium':
        return osPath.join(support, 'Chromium');
    }
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || osPath.join(home, 'AppData', 'Local');
    switch (kind) {
      case 'chrome':
        return osPath.join(local, 'Google', 'Chrome', 'User Data');
      case 'edge':
        return osPath.join(local, 'Microsoft', 'Edge', 'User Data');
      case 'brave':
        return osPath.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data');
      case 'chromium':
        return osPath.join(local, 'Chromium', 'User Data');
    }
  }
  switch (kind) {
    case 'chrome':
      return osPath.join(home, '.config', 'google-chrome');
    case 'edge':
      return osPath.join(home, '.config', 'microsoft-edge');
    case 'brave':
      return osPath.join(home, '.config', 'BraveSoftware', 'Brave-Browser');
    case 'chromium':
      return osPath.join(home, '.config', 'chromium');
  }
}

export function executableCandidates(
  kind: ChromiumKind,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string[] {
  if (platform === 'darwin') {
    const macApp = (appName: string, binary: string): string[] => {
      const bundle = `${appName}.app/Contents/MacOS/${binary}`;
      return [`/Applications/${bundle}`, path.posix.join(home, 'Applications', bundle)];
    };
    switch (kind) {
      case 'chrome':
        return macApp('Google Chrome', 'Google Chrome');
      case 'edge':
        return macApp('Microsoft Edge', 'Microsoft Edge');
      case 'brave':
        return macApp('Brave Browser', 'Brave Browser');
      case 'chromium':
        return macApp('Chromium', 'Chromium');
    }
  }
  if (platform === 'win32') {
    const pf = env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || '';
    switch (kind) {
      case 'chrome':
        return [
          path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ];
      case 'edge':
        return [
          path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ];
      case 'brave':
        return [
          path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        ];
      case 'chromium':
        return [path.join(local, 'Chromium', 'Application', 'chrome.exe')];
    }
  }
  switch (kind) {
    case 'chrome':
      return [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chrome',
        '/opt/google/chrome/chrome',
        '/snap/bin/google-chrome',
      ];
    case 'edge':
      return ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
    case 'brave':
      return [
        '/usr/bin/brave-browser',
        '/usr/bin/brave-browser-stable',
        '/usr/bin/brave',
        '/opt/brave.com/brave/brave-browser',
        '/snap/bin/brave',
      ];
    case 'chromium':
      return [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/lib/chromium/chromium',
        '/usr/lib/chromium-browser/chromium-browser',
        '/snap/bin/chromium',
      ];
  }
}

export function parseDefaultHandler(
  platform: NodeJS.Platform,
  raw: string | null | undefined,
): DefaultBrowserKind {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;

  if (platform === 'darwin') {
    const blocks = [...text.matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0]);
    let last: DefaultBrowserKind = null;
    for (const block of blocks) {
      if (!/LSHandlerURLScheme\s*=\s*"?https"?/i.test(block)) continue;
      const idMatch = block.match(/LSHandlerRoleAll\s*=\s*"?([^";\s]+)"?/i);
      if (!idMatch) continue;
      last = mapBundleId(idMatch[1]);
    }
    if (last) return last;
    return mapBundleId(text);
  }

  if (platform === 'win32') {
    const match = text.match(/ProgId\s+REG_SZ\s+(\S+)/i) ?? text.match(/^\s*(\S+)\s*$/m);
    return mapProgId(match?.[1] ?? text);
  }

  const desktop = text.split('/').pop()?.toLowerCase() ?? text.toLowerCase();
  return DESKTOP_TO_KIND[desktop] ?? 'other';
}

function mapBundleId(id: string): DefaultBrowserKind {
  return BUNDLE_ID_TO_KIND[id.trim().toLowerCase()] ?? 'other';
}

function mapProgId(id: string): DefaultBrowserKind {
  const normalized = id.trim().toLowerCase().replace(/-\S+$/, '');
  for (const [key, kind] of Object.entries(PROGID_TO_KIND)) {
    if (normalized.startsWith(key)) return kind;
  }
  return 'other';
}

export function listInstalledChromium(options: {
  platform: NodeJS.Platform;
  home: string;
  env?: NodeJS.ProcessEnv;
  exists?: (filePath: string) => boolean;
}): InstalledChromium[] {
  const exists = options.exists ?? ((filePath) => fs.existsSync(filePath));
  const env = options.env ?? process.env;
  const found: InstalledChromium[] = [];
  for (const kind of CHROMIUM_KINDS) {
    const executablePath = executableCandidates(kind, options.platform, env, options.home).find(
      exists,
    );
    if (!executablePath) continue;
    found.push({
      kind,
      executablePath,
      userDataDir: userDataDirFor(kind, options.platform, options.home, env, executablePath),
    });
  }
  return found;
}

export function resolveSourceBrowser(options: {
  defaultKind: DefaultBrowserKind;
  installed: InstalledChromium[];
}): InstalledChromium {
  const { defaultKind, installed } = options;
  if (defaultKind && defaultKind !== 'other') {
    const match = installed.find((item) => item.kind === defaultKind);
    if (match) return match;
  }
  for (const kind of CHROMIUM_KINDS) {
    const match = installed.find((item) => item.kind === kind);
    if (match) return match;
  }
  throw new RealProfileError(
    'NO_CHROMIUM',
    'No Chrome, Edge, or Brave install found to copy logins from.',
  );
}

export function detectDefaultHandlerFromOs(options?: {
  platform?: NodeJS.Platform;
  run?: (command: string, args: string[]) => string | null;
}): DefaultBrowserKind {
  const platform = options?.platform ?? process.platform;
  const run =
    options?.run ??
    ((command, args) => {
      try {
        return execFileSync(command, args, {
          encoding: 'utf8',
          timeout: 4000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null;
      }
    });

  if (platform === 'darwin') {
    return parseDefaultHandler(
      platform,
      run('defaults', [
        'read',
        'com.apple.LaunchServices/com.apple.launchservices.secure',
        'LSHandlers',
      ]),
    );
  }
  if (platform === 'win32') {
    return parseDefaultHandler(
      platform,
      run('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
        '/v',
        'ProgId',
      ]),
    );
  }
  return parseDefaultHandler(platform, run('xdg-settings', ['get', 'default-web-browser']));
}

export function resolveSourceBrowserFromOs(options?: {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (filePath: string) => boolean;
  run?: (command: string, args: string[]) => string | null;
}): InstalledChromium {
  const platform = options?.platform ?? process.platform;
  const home = options?.home ?? os.homedir();
  const installed = listInstalledChromium({
    platform,
    home,
    env: options?.env,
    exists: options?.exists,
  });
  const defaultKind = detectDefaultHandlerFromOs({ platform, run: options?.run });
  return resolveSourceBrowser({ defaultKind, installed });
}
