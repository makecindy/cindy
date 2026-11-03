import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => h.exec }));
import {
  linuxModeEntries,
  linuxInputMapping,
  linuxMonitor,
  linuxMonitors,
  readLinuxDisplayModes,
  setLinuxDisplayMode,
  type LinuxMonitor,
} from '../linuxDesktop';

const monitor: LinuxMonitor = {
  name: 'eDP-2',
  width: 2560,
  height: 1600,
  refreshRate: 60.002,
  x: 0,
  y: 0,
  scale: 1.6,
  transform: 0,
  availableModes: ['2560x1600@240.00Hz', '2560x1600@60.00Hz'],
};
beforeEach(() => {
  h.exec.mockReset().mockResolvedValue({ stdout: JSON.stringify([monitor]) });
});
it('exposes actual modes with stable numeric IDs and logical input geometry', () => {
  const modes = linuxModeEntries(monitor);
  expect(modes.map((m) => [m.width, m.height, m.current])).toEqual([
    [1600, 1000, false],
    [1600, 1000, true],
  ]);
  expect(modes.every((m) => /^\d{1,10}$/.test(m.id))).toBe(true);
  expect(
    linuxModeEntries({ ...monitor, availableModes: [...monitor.availableModes].reverse() })[0].id,
  ).toBe(modes[1].id);
});
it('selects only an enumerated monitor and refuses forged mode IDs before writes', async () => {
  await expect(linuxMonitor('hyprland:other')).rejects.toThrow('DESKTOP_DISPLAY_MISSING');
  const current = vi.fn();
  await expect(setLinuxDisplayMode('hyprland:eDP-2', '123456', current)).rejects.toThrow(
    'DESKTOP_DISPLAY_MODE_MISSING',
  );
  expect(current).not.toHaveBeenCalled();
  expect(h.exec.mock.calls.every((c) => c[1][0] === '-j')).toBe(true);
});
it('rechecks the lease after enumeration and before changing the output', async () => {
  const selected = linuxModeEntries(monitor)[0];
  await expect(
    setLinuxDisplayMode('hyprland:eDP-2', selected.id, () => {
      throw new Error('DESKTOP_LEASE_EXPIRED');
    }),
  ).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  expect(h.exec).toHaveBeenCalledTimes(2);
  h.exec
    .mockResolvedValueOnce({ stdout: JSON.stringify([monitor]) })
    .mockRejectedValueOnce(new Error('legacy'))
    .mockResolvedValueOnce({ stdout: 'ok\n' });
  await setLinuxDisplayMode('hyprland:eDP-2', selected.id, () => {});
  expect(h.exec).toHaveBeenLastCalledWith(
    '/usr/bin/hyprctl',
    ['keyword', 'monitor', 'eDP-2,2560x1600@240.00,0x0,1.6,transform,0'],
    expect.any(Object),
  );
});
it('uses Lua without a failed mutation first and checks revocation after the probe', async () => {
  const mode = linuxModeEntries(monitor)[0];
  h.exec
    .mockResolvedValueOnce({ stdout: JSON.stringify([monitor]) })
    .mockResolvedValueOnce({ stdout: 'ok' })
    .mockResolvedValueOnce({ stdout: 'ok' });
  await setLinuxDisplayMode('hyprland:eDP-2', mode.id, () => {});
  expect(h.exec.mock.calls[2][1]).toEqual([
    'eval',
    expect.stringContaining('mode="2560x1600@240.00"'),
  ]);
  h.exec.mockClear();
  h.exec
    .mockResolvedValueOnce({ stdout: JSON.stringify([monitor]) })
    .mockResolvedValueOnce({ stdout: 'ok' });
  await expect(
    setLinuxDisplayMode('hyprland:eDP-2', mode.id, () => {
      throw new Error('DESKTOP_LEASE_EXPIRED');
    }),
  ).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  expect(h.exec).toHaveBeenCalledTimes(2);
});
it('maps a negative-origin rotated monitor without sending clicks to its neighbour', () => {
  const left = { ...monitor, name: 'DP-1', x: -1000, transform: 1 };
  const point = linuxInputMapping([left, monitor], 'hyprland:DP-1');
  expect(point(0, 0)).toEqual({ x: 0, y: 0 });
  expect(point(1, 1)).toEqual({ x: 999 / 2600, y: 1599 / 1600 });
  const right = linuxInputMapping([left, monitor], 'hyprland:eDP-2');
  expect(right(0, 0).x).toBe(1000 / 2600);
});
it('reads physical modes while phone-fit hides the source from the active layout', async () => {
  const virtual = {
    ...monitor,
    name: 'CindyRemote-1234567812345678',
    width: 800,
    height: 600,
    scale: 1,
  };
  h.exec.mockImplementation(async (_file, args: string[]) => ({
    stdout: JSON.stringify(
      args.includes('all') ? [{ ...monitor, mirrorOf: virtual.name }, virtual] : [virtual],
    ),
  }));
  expect(await readLinuxDisplayModes('hyprland:eDP-2')).toEqual(
    linuxModeEntries(monitor).map(({ id, width, height, current }) => ({
      id,
      width,
      height,
      current,
    })),
  );
  expect((await linuxMonitors()).map((m) => m.name)).toEqual([virtual.name]);
  await expect(linuxMonitor('hyprland:eDP-2')).rejects.toThrow('DESKTOP_DISPLAY_MISSING');
});
