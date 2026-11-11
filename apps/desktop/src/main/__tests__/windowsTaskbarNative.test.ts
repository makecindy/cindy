import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getAppPath: vi.fn(), getPath: vi.fn() },
  exec: vi.fn(),
  require: vi.fn(),
  fs: {
    access: vi.fn(),
    readFile: vi.fn(),
    mkdtemp: vi.fn(),
    mkdir: vi.fn(),
    copyFile: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
  },
}));
vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('node:fs/promises', () => ({ default: mocks.fs }));
vi.mock('node:module', () => ({ createRequire: () => mocks.require }));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => mocks.exec }));

const platform = process.platform;
const arch = process.arch;
const root = path.join(os.tmpdir(), 'taskbar-in-memory-fixture');
const addon = { setOverlayIcon() {}, taskbarButtonCreatedMessage: () => 0xc123 };

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
  mocks.app.isPackaged = false;
  mocks.app.getAppPath.mockReturnValue(path.join(root, 'app'));
  mocks.app.getPath.mockReturnValue(path.join(root, 'profile'));
  mocks.fs.readFile.mockResolvedValue(Buffer.from('source version'));
  mocks.fs.access.mockRejectedValue(new Error('missing'));
  mocks.fs.mkdtemp.mockResolvedValue(path.join(root, 'build'));
  mocks.fs.rename.mockResolvedValue(undefined);
  mocks.require.mockReturnValue(addon);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
});

describe('Windows taskbar native loading', () => {
  it('loads the packaged addon without a compiler or source files', async () => {
    mocks.app.isPackaged = true;
    const resources = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', {
      value: path.join(root, 'resources'),
      configurable: true,
    });
    try {
      const { loadWindowsTaskbarNative } = await import('../windowsTaskbarNative');
      expect(await loadWindowsTaskbarNative()).toBe(addon);
      expect(mocks.require).toHaveBeenCalledWith(
        path.join(root, 'resources', 'tools', 'windows-taskbar', 'cindy-windows-taskbar.node'),
      );
      expect(mocks.fs.readFile).not.toHaveBeenCalled();
      expect(mocks.exec).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
    }
  });

  it('coalesces dev builds, uses the right architecture and cleans temporary outputs', async () => {
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    const { loadWindowsTaskbarNative } = await import('../windowsTaskbarNative');
    const first = loadWindowsTaskbarNative();
    expect(loadWindowsTaskbarNative()).toBe(first);
    expect(await first).toBe(addon);
    expect(mocks.exec).toHaveBeenCalledWith(
      'cargo',
      expect.arrayContaining([
        '--locked',
        '--target',
        'aarch64-pc-windows-msvc',
        '--target-dir',
        path.join(root, 'build'),
      ]),
      expect.objectContaining({ windowsHide: true }),
    );
    expect(mocks.fs.copyFile).toHaveBeenCalledWith(
      path.join(root, 'build', 'aarch64-pc-windows-msvc', 'release', 'cindy_windows_taskbar.dll'),
      expect.stringContaining(path.join(root, 'profile', 'windows-taskbar')),
    );
    expect(mocks.fs.rename).toHaveBeenCalledTimes(1);
    expect(mocks.fs.rm).toHaveBeenCalledWith(path.join(root, 'build'), {
      recursive: true,
      force: true,
    });
  });

  it('reuses only the cache for the current source bytes', async () => {
    mocks.fs.access.mockResolvedValue(undefined);
    let loader = await import('../windowsTaskbarNative');
    await loader.loadWindowsTaskbarNative();
    const firstPath = mocks.require.mock.calls[0][0];
    vi.resetModules();
    mocks.fs.readFile.mockResolvedValue(Buffer.from('changed source version'));
    loader = await import('../windowsTaskbarNative');
    await loader.loadWindowsTaskbarNative();
    expect(mocks.require.mock.calls[1][0]).not.toBe(firstPath);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('cleans a failed build and does not repeat it on every badge update', async () => {
    mocks.exec.mockRejectedValue(new Error('compiler unavailable'));
    const { loadWindowsTaskbarNative } = await import('../windowsTaskbarNative');
    await expect(loadWindowsTaskbarNative()).rejects.toThrow('compiler unavailable');
    await expect(loadWindowsTaskbarNative()).rejects.toThrow('compiler unavailable');
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.fs.rm).toHaveBeenCalledWith(path.join(root, 'build'), {
      recursive: true,
      force: true,
    });
    expect(mocks.require).not.toHaveBeenCalled();
  });

  it('does not build or load on another platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { loadWindowsTaskbarNative } = await import('../windowsTaskbarNative');
    await expect(loadWindowsTaskbarNative()).rejects.toThrow('Windows-only');
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.require).not.toHaveBeenCalled();
  });
});
