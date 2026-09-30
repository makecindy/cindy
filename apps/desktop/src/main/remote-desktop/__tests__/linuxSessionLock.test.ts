import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => h.exec }));
import { isLinuxDesktopUnlocked } from '../linuxSessionLock';
beforeEach(() => h.exec.mockReset());
it.each([
  [[{ solitaryBlockedBy: [] }], true],
  [[{ solitaryBlockedBy: ['LOCK'] }], false],
  [[{ solitaryBlockedBy: [] }, { solitaryBlockedBy: ['LOCK'] }], false],
  [[{ solitaryBlockedBy: ['WORKSPACE'] }], false],
  [[{}], false],
  [[{ solitaryBlockedBy: [1] }], false],
  [[], false],
  [null, false],
])('uses actual compositor lock evidence: %j', async (monitors, expected) => {
  h.exec.mockResolvedValue({ stdout: JSON.stringify(monitors) });
  expect(await isLinuxDesktopUnlocked()).toBe(expected);
  expect(h.exec).toHaveBeenCalledWith('/usr/bin/hyprctl', ['-j', 'monitors'], expect.any(Object));
});
it('refuses unreadable or malformed compositor state', async () => {
  h.exec.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ stdout: 'bad json' });
  expect(await isLinuxDesktopUnlocked()).toBe(false);
  expect(await isLinuxDesktopUnlocked()).toBe(false);
});
