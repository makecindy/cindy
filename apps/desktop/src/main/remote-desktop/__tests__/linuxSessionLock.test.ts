import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => h.exec }));
import { isLinuxDesktopUnlocked, isLogindSessionUnlocked } from '../linuxSessionLock';
beforeEach(() => h.exec.mockReset());
afterEach(() => vi.unstubAllGlobals());
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

// Production entry: isLogindSessionUnlocked gates X11 and GNOME remote clipboard
// on local desktop sessions with systemd-logind, failing closed when locked,
// switched away on a physical seat, owned by another user, or malformed.
it.each([
  ['unlocked seated session', 'User=1000\nSeat=seat0\nActive=yes\nLockedHint=no\n', true],
  ['unlocked seatless session', 'User=1000\nSeat=\nActive=no\nLockedHint=no\n', true],
  ['locked session', 'User=1000\nSeat=seat0\nActive=yes\nLockedHint=yes\n', false],
  ['inactive seated VT locker', 'User=1000\nSeat=seat0\nActive=no\nLockedHint=no\n', false],
  ['wrong user session', 'User=1001\nSeat=seat0\nActive=yes\nLockedHint=no\n', false],
  ['missing LockedHint', 'User=1000\nSeat=seat0\nActive=yes\n', false],
])('checks logind session lock state: %s', async (_name, stdout, expected) => {
  vi.stubGlobal('process', { ...process, getuid: () => 1000 });
  h.exec.mockResolvedValue({ stdout });
  expect(await isLogindSessionUnlocked({ XDG_SESSION_ID: '2' })).toBe(expected);
  expect(h.exec).toHaveBeenCalledWith(
    '/usr/bin/loginctl',
    ['show-session', '2', '-p', 'User', '-p', 'Seat', '-p', 'Active', '-p', 'LockedHint'],
    expect.any(Object),
  );
});

it('rejects missing, malformed or failing logind session probes without leaking', async () => {
  expect(await isLogindSessionUnlocked({})).toBe(false);
  expect(await isLogindSessionUnlocked({ XDG_SESSION_ID: '--bad' })).toBe(false);
  expect(h.exec).not.toHaveBeenCalled();
  h.exec.mockRejectedValueOnce(new Error('loginctl failed'));
  expect(await isLogindSessionUnlocked({ XDG_SESSION_ID: '2' })).toBe(false);
});
