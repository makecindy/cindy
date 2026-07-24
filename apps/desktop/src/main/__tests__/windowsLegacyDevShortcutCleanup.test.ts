import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('not used in tests');
    },
  },
  shell: {
    readShortcutLink: () => {
      throw new Error('not used in tests');
    },
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  cleanupLegacyDevShortcuts,
  type LegacyDevShortcutCleanupDeps,
} from '../windowsLegacyDevShortcutCleanup';

const APP_DATA = 'C:\\Users\\u\\AppData\\Roaming';
const START_MENU = path.join(APP_DATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');

function dirEntry(name: string, kind: 'directory' | 'file') {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
  };
}

function makeHarness(options?: {
  files?: Record<string, Electron.ShortcutDetails>;
  dirs?: Record<string, Array<ReturnType<typeof dirEntry>>>;
}) {
  const files = new Map<string, Electron.ShortcutDetails>(Object.entries(options?.files ?? {}));
  const dirs = new Map(Object.entries(options?.dirs ?? {}));
  const removed: string[] = [];
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deps: LegacyDevShortcutCleanupDeps = {
    platform: 'win32',
    appDataDir: () => APP_DATA,
    exists: async (filePath) => files.has(filePath),
    readdir: async (dirPath) => dirs.get(dirPath) ?? [],
    unlink: async (filePath) => {
      if (!files.delete(filePath)) throw new Error(`ENOENT ${filePath}`);
      removed.push(filePath);
    },
    readShortcut: (filePath) => {
      const details = files.get(filePath);
      if (!details) throw new Error(`ENOENT ${filePath}`);
      return details;
    },
    logger,
  };
  return { deps, dirs, files, logger, removed };
}

describe('cleanupLegacyDevShortcuts', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('removes the known SnoreToast shortcut by exact legacy name', async () => {
    const knownShortcut = path.join(START_MENU, 'XdtMakerDev.lnk');
    const { deps, files, removed } = makeHarness({
      files: {
        [knownShortcut]: {
          target: 'C:\\somewhere\\legacy.exe',
          args: '--legacy',
        },
      },
    });

    await cleanupLegacyDevShortcuts(deps);

    expect(files.has(knownShortcut)).toBe(false);
    expect(removed).toEqual([knownShortcut]);
  });

  it('recursively removes only argumentless dev Electron shortcuts', async () => {
    const nestedDir = path.join(START_MENU, 'Nested');
    const rootDevShortcut = path.join(START_MENU, 'Electron.lnk');
    const nestedDevShortcut = path.join(nestedDir, 'OldElectron.lnk');
    const shortcutWithArgs = path.join(START_MENU, 'KeepArgs.lnk');
    const unrelatedShortcut = path.join(START_MENU, 'Other.lnk');
    const { deps, files, removed } = makeHarness({
      dirs: {
        [START_MENU]: [
          dirEntry('Nested', 'directory'),
          dirEntry('Electron.lnk', 'file'),
          dirEntry('KeepArgs.lnk', 'file'),
          dirEntry('Other.lnk', 'file'),
          dirEntry('README.txt', 'file'),
        ],
        [nestedDir]: [dirEntry('OldElectron.lnk', 'file')],
      },
      files: {
        [rootDevShortcut]: {
          target: 'C:/repo/node_modules/electron/dist/electron.exe',
        },
        [nestedDevShortcut]: {
          target: 'D:\\code\\node_modules\\electron\\dist\\electron.exe',
          args: '',
        },
        [shortcutWithArgs]: {
          target: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
          args: 'C:\\repo',
        },
        [unrelatedShortcut]: {
          target: 'C:\\Program Files\\Electron\\electron.exe',
        },
      },
    });

    await cleanupLegacyDevShortcuts(deps);

    expect(removed).toEqual(expect.arrayContaining([rootDevShortcut, nestedDevShortcut]));
    expect(files.has(shortcutWithArgs)).toBe(true);
    expect(files.has(unrelatedShortcut)).toBe(true);
  });

  it('skips non-Windows platforms before touching the filesystem', async () => {
    const { deps } = makeHarness();
    deps.platform = 'darwin';
    const appDataDir = vi.fn(() => APP_DATA);
    deps.appDataDir = appDataDir;

    await cleanupLegacyDevShortcuts(deps);

    expect(appDataDir).not.toHaveBeenCalled();
  });

  it('swallows read, traversal, and unlink failures so startup continues', async () => {
    const knownShortcut = path.join(START_MENU, 'XdtMakerDev.lnk');
    const scannedShortcut = path.join(START_MENU, 'Electron.lnk');
    const { deps, logger } = makeHarness({
      dirs: {
        [START_MENU]: [
          dirEntry('Protected', 'directory'),
          dirEntry('Electron.lnk', 'file'),
        ],
      },
      files: {
        [knownShortcut]: { target: 'C:\\legacy.exe' },
        [scannedShortcut]: {
          target: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
        },
      },
    });
    deps.unlink = async () => {
      throw new Error('access denied');
    };
    deps.readShortcut = () => {
      throw new Error('corrupt link');
    };
    const originalReaddir = deps.readdir;
    deps.readdir = async (dirPath) => {
      if (dirPath.endsWith('Protected')) throw new Error('access denied');
      return originalReaddir(dirPath);
    };

    await expect(cleanupLegacyDevShortcuts(deps)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('stops blocking startup when the Start Menu scan times out', async () => {
    vi.useFakeTimers();
    const { deps, logger } = makeHarness();
    deps.readdir = () => new Promise(() => {});

    const cleanup = cleanupLegacyDevShortcuts(deps);
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(cleanup).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'legacy dev shortcut cleanup timed out; continuing startup',
      { timeoutMs: 8_000 },
    );
  });
});
