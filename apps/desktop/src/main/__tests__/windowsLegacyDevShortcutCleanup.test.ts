import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => {
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
  parseWindowsShortcut,
  type LegacyDevShortcutCleanupDeps,
  type LegacyShortcutDetails,
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
  files?: Record<string, { target: string; args?: string }>;
  dirs?: Record<string, Array<ReturnType<typeof dirEntry>>>;
}) {
  const files = new Map<string, { target: string; args?: string }>(
    Object.entries(options?.files ?? {}),
  );
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
    readShortcut: async (filePath) => {
      const details = files.get(filePath);
      if (!details) throw new Error(`ENOENT ${filePath}`);
      return { target: details.target, args: details.args ?? '' };
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
    deps.readShortcut = async () => {
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

  it('stops the pending Start Menu scan from resuming work after timeout', async () => {
    vi.useFakeTimers();
    const { deps, logger, removed } = makeHarness();
    let finishReaddir: ((entries: ReturnType<typeof dirEntry>[]) => void) | undefined;
    deps.readdir = () =>
      new Promise((resolve) => {
        finishReaddir = resolve;
      });
    const readShortcut = vi.fn(async (): Promise<LegacyShortcutDetails> => ({
      target: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
      args: '',
    }));
    deps.readShortcut = readShortcut;

    const cleanup = cleanupLegacyDevShortcuts(deps);
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(cleanup).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'legacy dev shortcut cleanup timed out; continuing startup',
      { timeoutMs: 8_000 },
    );

    finishReaddir?.([dirEntry('Electron.lnk', 'file')]);
    await Promise.resolve();
    await Promise.resolve();

    expect(readShortcut).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
  });

  it('lets the deadline win when a single shortcut resolution never completes', async () => {
    // Resolution is now async, so one hanging read cannot hold the main thread
    // past the deadline the way a synchronous shell.readShortcutLink call could.
    vi.useFakeTimers();
    const shortcut = path.join(START_MENU, 'Electron.lnk');
    const { deps, logger, removed } = makeHarness({
      dirs: { [START_MENU]: [dirEntry('Electron.lnk', 'file')] },
    });
    deps.readShortcut = () => new Promise<LegacyShortcutDetails>(() => {});

    const cleanup = cleanupLegacyDevShortcuts(deps);
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(cleanup).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'legacy dev shortcut cleanup timed out; continuing startup',
      { timeoutMs: 8_000 },
    );
    expect(removed).toEqual([]);
    expect(shortcut).toContain('Electron.lnk');
  });
});

describe('parseWindowsShortcut', () => {
  const SHELL_LINK_CLSID = Buffer.from([
    0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
  ]);

  function buildLnk(opts: { target: string; args?: string }): Buffer {
    const header = Buffer.alloc(0x4c);
    header.writeUInt32LE(0x4c, 0);
    SHELL_LINK_CLSID.copy(header, 4);
    let flags = 0x0000_0002; // HasLinkInfo
    const hasArgs = opts.args !== undefined;
    if (hasArgs) flags |= 0x0000_0020; // HasArguments
    header.writeUInt32LE(flags, 20);

    const linkInfoHeaderSize = 0x1c;
    const baseBytes = Buffer.from(opts.target, 'latin1');
    const localBasePathOffset = linkInfoHeaderSize;
    const suffixOffset = localBasePathOffset + baseBytes.length + 1;
    const linkInfoSize = suffixOffset + 1;
    const linkInfo = Buffer.alloc(linkInfoSize);
    linkInfo.writeUInt32LE(linkInfoSize, 0);
    linkInfo.writeUInt32LE(linkInfoHeaderSize, 4);
    linkInfo.writeUInt32LE(0x1, 8); // VolumeIDAndLocalBasePath
    linkInfo.writeUInt32LE(linkInfoHeaderSize, 12); // VolumeIDOffset (unused here)
    linkInfo.writeUInt32LE(localBasePathOffset, 16);
    linkInfo.writeUInt32LE(0, 20); // CommonNetworkRelativeLinkOffset
    linkInfo.writeUInt32LE(suffixOffset, 24);
    baseBytes.copy(linkInfo, localBasePathOffset);

    const parts = [header, linkInfo];
    if (hasArgs) {
      const argBytes = Buffer.from(opts.args!, 'latin1');
      const stringData = Buffer.alloc(2 + argBytes.length);
      stringData.writeUInt16LE(argBytes.length, 0);
      argBytes.copy(stringData, 2);
      parts.push(stringData);
    }
    return Buffer.concat(parts);
  }

  it('decodes an argumentless dev Electron target from raw .lnk bytes', () => {
    const target = 'C:\\repo\\node_modules\\electron\\dist\\electron.exe';
    expect(parseWindowsShortcut(buildLnk({ target }))).toEqual({ target, args: '' });
  });

  it('decodes command-line arguments when present', () => {
    const target = 'C:\\repo\\node_modules\\electron\\dist\\electron.exe';
    expect(parseWindowsShortcut(buildLnk({ target, args: 'C:\\repo' }))).toEqual({
      target,
      args: 'C:\\repo',
    });
  });

  it('returns null for buffers that are not shell links', () => {
    expect(parseWindowsShortcut(Buffer.from('not a shortcut'))).toBeNull();
    expect(parseWindowsShortcut(Buffer.alloc(0x4c))).toBeNull();
  });
});
