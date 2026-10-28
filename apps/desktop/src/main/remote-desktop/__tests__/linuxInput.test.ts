import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  exec: vi.fn(),
  displays: [{ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } }],
}));
vi.mock('electron', () => ({
  app: { isPackaged: true },
  screen: { getAllDisplays: () => h.displays },
}));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => h.exec }));
import { linuxInputBackend, linuxX11Geometry, readLinuxDesktopInputSupport } from '../linuxInput';

// Test value: new production backend/probe entry, not native source text. Previously
// X11 always returned false. Existing inputHost tests inject a prepared binary and
// cannot catch XWayland admission, unavailable XTEST, or selection of the wrong
// packaged helper. Minimal input: Linux + DISPLAY + ready helper. Unit tier uses
// fake subprocess replies only; native injection belongs to explicit Xvfb tests.
// Regression: startx/SSH may inherit XDG_SESSION_TYPE=tty despite reachable X11;
// DISPLAY must reach the native probe unless the environment identifies Wayland.
// Standalone Vitest duration on Windows: 0.402 s (17 tests).
beforeEach(() => {
  vi.stubGlobal('process', {
    ...process,
    platform: 'linux',
    resourcesPath: path.resolve('test-runtime'),
  });
  vi.stubEnv('XDG_SESSION_TYPE', 'x11');
  vi.stubEnv('DISPLAY', ':99');
  vi.stubEnv('WAYLAND_DISPLAY', '');
  vi.stubEnv('HYPRLAND_INSTANCE_SIGNATURE', '');
  h.exec.mockReset().mockResolvedValue({ stdout: 'ready\n' });
  h.displays = [{ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } }];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([
  ['linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, 'x11'],
  ['linux', { DISPLAY: ':0' }, 'x11'],
  ['linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' }, null],
  ['linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, null],
  ['linux', { WAYLAND_DISPLAY: 'wayland-0', HYPRLAND_INSTANCE_SIGNATURE: 'fixture' }, 'wayland'],
  ['linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'tty' }, 'x11'],
  ['linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'tty', WAYLAND_DISPLAY: 'wayland-0' }, null],
  ['linux', {}, null],
  ['win32', { DISPLAY: ':0' }, null],
] as const)('selects only a native supported desktop: %s %j', (platform, env, expected) => {
  expect(linuxInputBackend(platform, env)).toBe(expected);
});

it.each([
  ['x11', 'x11'],
  ['x11', 'tty'],
  ['wayland', 'wayland'],
] as const)(
  'probes the packaged %s helper in a %s session without input arguments',
  async (backend, sessionType) => {
    vi.stubEnv('XDG_SESSION_TYPE', sessionType);
    if (backend === 'wayland') {
      vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
      vi.stubEnv('HYPRLAND_INSTANCE_SIGNATURE', 'fixture');
    }
    expect(await readLinuxDesktopInputSupport()).toBe(true);
    const name = backend === 'x11' ? 'cindy-linux-x11-desktop-input' : 'cindy-linux-desktop-input';
    expect(h.exec).toHaveBeenCalledExactlyOnceWith(
      path.join(process.resourcesPath, 'tools', 'remote-desktop', name),
      ['--check'],
      { timeout: 3000, maxBuffer: 1024 },
    );
  },
);

it.each(['unsupported', 'failure'])(
  'does not advertise unavailable native input: %s',
  async (result) => {
    if (result === 'failure') h.exec.mockRejectedValue(new Error('missing library or display'));
    else h.exec.mockResolvedValue({ stdout: 'unsupported\n' });
    expect(await readLinuxDesktopInputSupport()).toBe(false);
  },
);

it('does not probe XWayland as a way around missing Wayland input support', async () => {
  vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
  expect(await readLinuxDesktopInputSupport()).toBe(false);
  expect(h.exec).not.toHaveBeenCalled();
});

it('preserves positive framebuffer margins when mapping a scaled monitor into root pixels', () => {
  const displays = [
    { id: 1, scaleFactor: 2, bounds: { x: 50, y: 25, width: 100, height: 100 } },
    { id: 2, scaleFactor: 2, bounds: { x: 150, y: 25, width: 200, height: 100 } },
  ];
  expect(linuxX11Geometry(displays, '2')).toEqual(['--geometry', '300', '50', '400', '200']);
  expect(linuxX11Geometry([displays[0]], '1')).toEqual(['--geometry', '100', '50', '200', '200']);
  expect(() => linuxX11Geometry(displays, '3')).toThrow('DESKTOP_DISPLAY_MISSING');
});

it('refuses mixed-scale or invalid X11 geometry rather than advertising unsafe control', async () => {
  expect(() =>
    linuxX11Geometry(
      [{ id: 1, scaleFactor: 1, bounds: { x: -100, y: 0, width: 100, height: 100 } }],
      '1',
    ),
  ).toThrow('DESKTOP_DISPLAY_MISSING');
  h.displays.push({ id: 2, scaleFactor: 2, bounds: { x: 100, y: 0, width: 100, height: 100 } });
  expect(await readLinuxDesktopInputSupport()).toBe(false);
  expect(h.exec).not.toHaveBeenCalled();
  expect(() => linuxX11Geometry(h.displays, '1')).toThrow('DESKTOP_DISPLAY_MISSING');
  expect(() =>
    linuxX11Geometry(
      [{ ...h.displays[0], bounds: { x: NaN, y: 0, width: 100, height: 100 } }],
      '1',
    ),
  ).toThrow('DESKTOP_DISPLAY_MISSING');
});
