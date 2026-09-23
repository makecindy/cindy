import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getAppPath: vi.fn(() => '/development'),
    getPath: vi.fn(() => '/profile'),
  },
  exec: vi.fn(),
  open: vi.fn(),
  development: vi.fn(),
  installed: vi.fn(),
}));
vi.mock('../windowsDevelopment', () => ({
  createWindowsDevelopmentAssets: () => ({
    resolve: runtime.development,
    installed: runtime.installed,
  }),
}));
vi.mock('electron', () => ({ app: runtime.app }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: runtime.exec,
  }),
}));
vi.mock('node:module', () => ({
  createRequire: () => () => ({ DesktopConnection: { open: runtime.open } }),
}));
import {
  configureWindowsDesktopSupport,
  readWindowsDesktopSupport,
  uninstallWindowsDesktopSupportFrom,
} from '../windowsHost';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const customResources = path.join(os.tmpdir(), 'custom-cindy-install', 'resources');

beforeEach(() => {
  vi.clearAllMocks();
  runtime.app.isPackaged = true;
  runtime.exec.mockReset().mockResolvedValue({ stdout: 'ready\n' });
  runtime.open.mockReset().mockResolvedValue({ close: vi.fn(), request: vi.fn() });
  runtime.development.mockReset().mockResolvedValue(null);
  runtime.installed.mockReset().mockResolvedValue(null);
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: customResources });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath);
  else Reflect.deleteProperty(process, 'resourcesPath');
});

describe('Windows lock screen service setup', () => {
  it('checks an installed grant from a custom app directory without requesting elevation', async () => {
    expect(await readWindowsDesktopSupport()).toBe('ready');
    expect(await readWindowsDesktopSupport()).toBe('ready');
    expect(runtime.exec.mock.calls.map((call) => call[1])).toEqual([['--status'], ['--status']]);
    expect(runtime.open).toHaveBeenCalledWith(
      path.join(customResources, 'tools', 'remote-desktop', 'cindy-windows-desktop-host.exe'),
      JSON.stringify({ mode: 'probe' }),
    );
  });

  it('opens administrator setup only after an explicit enable action and verifies the real connection', async () => {
    const progress = vi.fn();
    await configureWindowsDesktopSupport(true, progress);
    expect(runtime.exec.mock.calls.map((call) => call[1])).toEqual([
      ['--elevate-install', String(process.pid)],
      ['--status'],
    ]);
    expect(runtime.open).toHaveBeenCalledOnce();
    expect(progress.mock.calls).toEqual([['authorizing'], ['verifying']]);
  });

  it('does not enable or retry elevation after UAC is cancelled', async () => {
    runtime.exec.mockRejectedValueOnce(new Error('UAC cancelled'));
    await expect(configureWindowsDesktopSupport(true)).rejects.toThrow('UAC cancelled');
    expect(runtime.exec).toHaveBeenCalledOnce();
    expect(runtime.open).not.toHaveBeenCalled();
  });

  it('keeps a registered but stopped service removable instead of treating it as missing', async () => {
    runtime.exec.mockResolvedValue({ stdout: 'unavailable\n' });
    expect(await readWindowsDesktopSupport()).toBe('unavailable');
    expect(runtime.open).not.toHaveBeenCalled();
  });

  it('keeps leftover protected install records removable after Main restarts', async () => {
    runtime.exec.mockResolvedValue({ stdout: 'unavailable\n' });
    expect(await readWindowsDesktopSupport()).toBe('unavailable');
  });

  it('uninstalls a personal-version lock-screen helper from that version resources tree', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    mkdirSync(path.join(customResources, 'tools', 'remote-desktop'), { recursive: true });
    writeFileSync(
      path.join(customResources, 'tools', 'remote-desktop', 'cindy-windows-desktop-host.exe'),
      'helper',
    );
    try {
      await uninstallWindowsDesktopSupportFrom(customResources);
      expect(runtime.exec.mock.calls.map((call) => call[1])).toEqual([['--status'], ['--uninstall']]);
    } finally {
      rmSync(customResources, { recursive: true, force: true });
    }
  });

  it('skips personal-version uninstall when that snapshot has no helper', async () => {
    await uninstallWindowsDesktopSupportFrom(path.join(os.tmpdir(), 'cindy-missing-resources'));
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it('does not request elevation when a personal version never had a lock-screen service', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    mkdirSync(path.join(customResources, 'tools', 'remote-desktop'), { recursive: true });
    writeFileSync(
      path.join(customResources, 'tools', 'remote-desktop', 'cindy-windows-desktop-host.exe'),
      'helper',
    );
    runtime.exec.mockResolvedValue({ stdout: 'missing\n' });
    try {
      await uninstallWindowsDesktopSupportFrom(customResources);
      expect(runtime.exec.mock.calls.map((call) => call[1])).toEqual([['--status']]);
    } finally {
      rmSync(customResources, { recursive: true, force: true });
    }
  });

  it('elevates personal-version uninstall only after an unelevated removal fails', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    mkdirSync(path.join(customResources, 'tools', 'remote-desktop'), { recursive: true });
    writeFileSync(
      path.join(customResources, 'tools', 'remote-desktop', 'cindy-windows-desktop-host.exe'),
      'helper',
    );
    runtime.exec
      .mockResolvedValueOnce({ stdout: 'unavailable\n' })
      .mockRejectedValueOnce(new Error('access denied'))
      .mockResolvedValueOnce({ stdout: '' });
    try {
      await uninstallWindowsDesktopSupportFrom(customResources);
      expect(runtime.exec.mock.calls.map((call) => call[1])).toEqual([
        ['--status'],
        ['--uninstall'],
        ['--elevate-uninstall'],
      ]);
    } finally {
      rmSync(customResources, { recursive: true, force: true });
    }
  });

  it('does not treat a running service as authorization for another caller', async () => {
    runtime.open.mockRejectedValue(new Error('caller rejected'));
    expect(await readWindowsDesktopSupport()).toBe('unavailable');
    await expect(configureWindowsDesktopSupport(true)).rejects.toThrow(
      'DESKTOP_SYSTEM_SERVICE_UNAVAILABLE',
    );
  });
  it('requires a successful Main probe before retaining manual control for an outdated service', async () => {
    runtime.exec.mockResolvedValue({ stdout: 'updateRequired\n' });
    expect(await readWindowsDesktopSupport()).toBe('updateRequired');
    expect(runtime.open).toHaveBeenCalledOnce();
    runtime.open.mockRejectedValue(new Error('caller rejected'));
    expect(await readWindowsDesktopSupport()).toBe('unavailable');
  });

  it('removes the service through the existing administrator action', async () => {
    await configureWindowsDesktopSupport(false);
    expect(runtime.exec.mock.calls.map((call) => call[1])).toEqual([['--elevate-uninstall']]);
    expect(runtime.open).not.toHaveBeenCalled();
  });

  it('keeps the macOS permission flow unchanged and makes Dev setup available without compiling during a probe', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(await readWindowsDesktopSupport()).toBeUndefined();
    await expect(configureWindowsDesktopSupport(true)).rejects.toThrow(
      'DESKTOP_SYSTEM_SERVICE_UNAVAILABLE',
    );
    Object.defineProperty(process, 'platform', { value: 'win32' });
    runtime.app.isPackaged = false;
    expect(await readWindowsDesktopSupport()).toBe('missing');
    expect(runtime.development).toHaveBeenCalledWith(false);
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it('prepares Dev components before elevation and reuses an already installed authorization', async () => {
    runtime.app.isPackaged = false;
    runtime.development.mockResolvedValue({
      binary: path.join(customResources, 'dev-host.exe'),
      addon: path.join(customResources, 'dev-host.node'),
    });
    await configureWindowsDesktopSupport(true);
    expect(runtime.development).toHaveBeenNthCalledWith(1, true);
    expect(runtime.exec.mock.calls.map((call) => call[1])).toEqual([['--status']]);
  });

  it('probes an authorized Dev service with the last installed helper after the fingerprint changes', async () => {
    runtime.app.isPackaged = false;
    const installed = {
      binary: path.join(customResources, 'installed-host.exe'),
      addon: path.join(customResources, 'installed-host.node'),
    };
    runtime.installed.mockResolvedValue(installed);
    runtime.exec.mockResolvedValue({ stdout: 'ready\n' });
    expect(await readWindowsDesktopSupport()).toBe('updateRequired');
    expect(runtime.development).toHaveBeenCalledWith(false);
    expect(runtime.exec.mock.calls[0][0]).toBe(installed.binary);
    expect(runtime.open).toHaveBeenCalledWith(installed.binary, JSON.stringify({ mode: 'probe' }));
  });

  it('uninstalls an authorized Dev service from the last installed helper without rebuilding', async () => {
    runtime.app.isPackaged = false;
    const installed = {
      binary: path.join(customResources, 'installed-host.exe'),
      addon: path.join(customResources, 'installed-host.node'),
    };
    runtime.installed.mockResolvedValue(installed);
    runtime.exec.mockResolvedValue({ stdout: 'updateRequired\n' });
    expect(await readWindowsDesktopSupport()).toBe('updateRequired');
    expect(runtime.development).toHaveBeenCalledWith(false);
    expect(runtime.exec.mock.calls[0][0]).toBe(installed.binary);
    await configureWindowsDesktopSupport(false);
    expect(runtime.development.mock.calls.some((call) => call[0] === true)).toBe(false);
    expect(runtime.exec.mock.calls.at(-1)).toEqual([
      installed.binary,
      ['--elevate-uninstall'],
      expect.objectContaining({ windowsHide: true }),
    ]);
  });

  it('requests administrator approval when the prepared Dev service needs installation or update', async () => {
    runtime.app.isPackaged = false;
    runtime.development.mockResolvedValue({
      binary: path.join(customResources, 'dev-host.exe'),
      addon: path.join(customResources, 'dev-host.node'),
    });
    runtime.exec.mockResolvedValueOnce({ stdout: 'updateRequired\n' });
    await configureWindowsDesktopSupport(true);
    expect(runtime.exec.mock.calls.map((call) => call[1])).toEqual([
      ['--status'],
      ['--elevate-install', String(process.pid)],
      ['--status'],
    ]);
  });
});
