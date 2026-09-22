import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app', getPath: () => '/fake/profile' },
  exec: vi.fn(),
  spawn: vi.fn(),
  access: vi.fn(),
  accessSync: vi.fn(),
  displays: vi.fn(),
}));
vi.mock('electron', () => ({ app: mocks.app, screen: { getAllDisplays: mocks.displays } }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: mocks.spawn }));
vi.mock('node:util', () => ({ promisify: () => mocks.exec }));
vi.mock('node:fs', () => ({ accessSync: mocks.accessSync, constants: { X_OK: 1, R_OK: 4 } }));
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: async () => 'source',
    access: mocks.access,
    mkdir: vi.fn(),
    rename: vi.fn(),
  },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.app.isPackaged = false;
  mocks.exec.mockReset().mockResolvedValue({ stdout: '{"available":true}' });
  mocks.access.mockReset().mockResolvedValue(undefined);
  mocks.accessSync.mockReset();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(['grim', 'hyprctl', 'python3', 'linux-viewer-display.py', null])(
  'advertises Linux viewer displays only with all dependencies (missing=%s)',
  async (missing) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland');
    vi.stubEnv('HYPRLAND_INSTANCE_SIGNATURE', 'test');
    mocks.accessSync.mockImplementation((file: string) => {
      if (missing && file.endsWith(missing)) throw new Error('missing dependency');
    });
    const { viewerDisplaySupported, createViewerDisplay } = await import('../viewerDisplay');
    expect(await viewerDisplaySupported()).toBe(missing === null);
    if (missing) {
      await expect(createViewerDisplay('wayland-portal', () => true, vi.fn())).rejects.toThrow(
        'DESKTOP_VIEWER_DISPLAY_UNAVAILABLE',
      );
      expect(mocks.exec).not.toHaveBeenCalled();
    }
  },
);

it('waits for Electron to observe restored geometry and mirror removal', async () => {
  vi.useFakeTimers();
  const { waitForDisplayRestore } = await import('../viewerDisplay');
  let width = 800;
  let released = false;
  mocks.displays.mockImplementation(() => [{ id: 1, size: { width, height: 1080 } }]);
  const settled = vi.fn();
  const pending = waitForDisplayRestore(
    '1',
    { width: 1920, height: 1080 },
    () => {},
    () => released,
  ).then(settled);
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).not.toHaveBeenCalled();
  width = 1920;
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).not.toHaveBeenCalled();
  released = true;
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ width: 1920, height: 1080 }));
});

it.each(['unplugged', 'cancelled', 'timeout'] as const)(
  'settles a %s restoration wait',
  async (reason) => {
    vi.useFakeTimers();
    const { waitForDisplayRestore } = await import('../viewerDisplay');
    mocks.displays.mockReturnValue(
      reason === 'unplugged' ? [] : [{ id: 1, size: { width: 800, height: 600 } }],
    );
    const pending = waitForDisplayRestore('1', { width: 1920, height: 1080 }, () => {
      if (reason === 'cancelled') throw new Error('DESKTOP_LEASE_EXPIRED');
    });
    if (reason === 'unplugged') await expect(pending).resolves.toMatchObject({ id: '1' });
    else {
      const rejected = expect(pending).rejects.toThrow(
        reason === 'cancelled' ? 'DESKTOP_LEASE_EXPIRED' : 'DESKTOP_VIEWER_DISPLAY_UNAVAILABLE',
      );
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('probes an existing binary once across concurrent capability requests', async () => {
  const { viewerDisplaySupported } = await import('../viewerDisplay');
  expect(await Promise.all([viewerDisplaySupported(), viewerDisplaySupported()])).toEqual([
    true,
    true,
  ]);
  expect(mocks.exec).toHaveBeenCalledTimes(1);
  expect(mocks.exec).toHaveBeenCalledWith(
    expect.stringContaining('cindy-viewer-display'),
    ['--probe'],
    { timeout: 5000 },
  );
});
it('does not advertise support after a failed SPI probe', async () => {
  mocks.exec.mockRejectedValue(new Error('unsupported SPI'));
  const { viewerDisplaySupported } = await import('../viewerDisplay');
  expect(await viewerDisplaySupported()).toBe(false);
  expect(mocks.exec).toHaveBeenCalledTimes(1);
});
it('does not advertise support when compilation fails', async () => {
  mocks.access.mockRejectedValue(new Error('missing'));
  mocks.exec.mockRejectedValue(new Error('clang unavailable'));
  const { viewerDisplaySupported } = await import('../viewerDisplay');
  expect(await viewerDisplaySupported()).toBe(false);
  expect(mocks.exec).toHaveBeenCalledWith('clang', expect.any(Array), expect.any(Object));
});
it.each(['packaged', 'windows'] as const)('does no helper work for %s builds', async (kind) => {
  if (kind === 'packaged') mocks.app.isPackaged = true;
  else vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const { viewerDisplaySupported } = await import('../viewerDisplay');
  expect(await viewerDisplaySupported()).toBe(false);
  expect(mocks.exec).not.toHaveBeenCalled();
  expect(mocks.access).not.toHaveBeenCalled();
});

it.each([false, true])(
  'uses OS logical dimensions while matching the request (stale=%s)',
  async (stale) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    child.stdin.on('data', () =>
      queueMicrotask(() =>
        child.stdout.write(
          JSON.stringify({
            id: 9,
            width: stale ? 1280 : 1920,
            height: 1420,
            logicalWidth: 960,
            logicalHeight: 710,
          }) + '\n',
        ),
      ),
    );
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('exit', 0)));
    mocks.spawn.mockReturnValue(child);
    mocks.displays.mockReturnValue([
      { id: 4, size: { width: 2560, height: 1440 } },
      { id: 9, size: { width: 960, height: 710 } },
    ]);
    const { createViewerDisplay } = await import('../viewerDisplay');
    const handle = await createViewerDisplay('4', () => true, vi.fn());
    try {
      const result = handle.resize(1920, 1420, () => true);
      if (stale) await expect(result).rejects.toThrow('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE');
      else await expect(result).resolves.toMatchObject({ id: '9', width: 960, height: 710 });
    } finally {
      handle.dispose();
    }
  },
);
